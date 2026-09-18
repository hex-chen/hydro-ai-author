/**
 * hydro-ai-author
 *  填一个 OpenAI 兼容接口，管理员在网页上让 AI 出题、建比赛。
 *  - 出题：AI 生成题面 + 标程 + 测试输入；标程在 go-judge 沙箱里跑出标准输出；写入题库（默认隐藏，待人工审核）。
 *  - 建比赛：可用 AI 新出若干题，或指定已有题号，自动创建比赛。
 *  任务在后台跑，页面轮询进度。
 */
import {
    ContestModel, Context, Handler, ObjectId, param, PERM, ProblemModel, Schema, Types, db, NotFoundError,
} from 'hydrooj';
import { buildUserPrompt, ProblemSpec, SYSTEM_PROMPT } from './prompts';

const API_KEY_PLACEHOLDER = 'YOUR_API_KEY';

export const Config = Schema.object({
    baseUrl: Schema.string().default('').description('OpenAI 兼容接口地址，例如 https://api.openai.com/v1 或 http://127.0.0.1:8080/v1'),
    apiKey: Schema.string().role('secret').default(API_KEY_PLACEHOLDER).description('API Key（接口不需要鉴权就保持占位符或留空）'),
    model: Schema.string().default('').description('模型名'),
    enableThinking: Schema.boolean().default(false).description('Qwen3 等模型开启思考（出题质量更好但更慢）'),
    maxTokens: Schema.number().default(16384).description('单次最多生成 token（题面+标程+数据，别设太小）'),
    timeout: Schema.number().default(600).description('单次请求超时（秒）'),
    sandboxUrl: Schema.string().default('http://127.0.0.1:5050').description('go-judge 沙箱地址，用来跑标程生成输出；留空则让 AI 直接给输出（不可靠）'),
    compileCmd: Schema.string().default('/usr/bin/g++ std.cpp -o std -O2 -std=c++17 -lm').description('沙箱里的编译命令'),
    hidden: Schema.boolean().default(true).description('AI 生成的题默认隐藏，人工审核后再公开'),
});

interface JobDoc {
    _id: ObjectId;
    domainId: string;
    uid: number;
    type: 'problem' | 'contest';
    status: 'running' | 'done' | 'error';
    title: string;
    log: string[];
    pids: number[];
    tid?: ObjectId;
    error?: string;
    createdAt: Date;
    updatedAt: Date;
}
declare module 'hydrooj' {
    interface Collections { ai_author_job: JobDoc }
}
const jobs = db.collection('ai_author_job');

// ---------- 解析 AI 的分段输出 ----------

interface Generated {
    title: string;
    tags: string[];
    time: number;   // ms
    memory: number; // MB
    content: string;
    std: string;
    tests: string[];
}

function parseSections(text: string): Generated {
    // 去掉可能包住整体的围栏
    let t = text.replace(/^\s*```[a-z]*\s*\n/i, '').replace(/\n```\s*$/i, '');
    // 去掉思考内容
    t = t.replace(/<think>[\s\S]*?<\/think>/g, '');
    const re = /^===\s*([A-Z]+(?:\s+\d+)?)\s*===\s*$/gm;
    const parts: Record<string, string> = {};
    const marks: { key: string, start: number, end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) marks.push({ key: m[1].replace(/\s+/g, ' ').trim(), start: m.index, end: m.index + m[0].length });
    for (let i = 0; i < marks.length; i++) {
        const body = t.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : t.length);
        parts[marks[i].key] = body.replace(/^\s*\n/, '').replace(/\s+$/, '');
    }
    if (!parts.TITLE || !parts.CONTENT || !parts.STD) {
        throw new Error(`AI 输出缺少必要分段（已找到：${Object.keys(parts).join(', ') || '无'}）`);
    }
    const limits = parts.LIMITS || '';
    const time = +(/time\s*=\s*(\d+)/.exec(limits)?.[1] || 1000);
    const memory = +(/memory\s*=\s*(\d+)/.exec(limits)?.[1] || 256);
    const tests = Object.keys(parts)
        .filter((k) => /^TEST \d+$/.test(k))
        .sort((a, b) => +a.slice(5) - +b.slice(5))
        .map((k) => parts[k]).filter((s) => s.trim().length);
    if (!tests.length) throw new Error('AI 没有给出测试数据');
    const std = dedupeCode(parts.STD);
    return {
        title: parts.TITLE.split('\n')[0].trim().slice(0, 60),
        tags: (parts.TAGS || '').split(/[,，、\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 6),
        time: Math.min(Math.max(time, 200), 10000),
        memory: Math.min(Math.max(memory, 32), 1024),
        content: parts.CONTENT,
        std,
        tests: tests.map((s) => (s.endsWith('\n') ? s : `${s}\n`)),
    };
}

// AI 偶尔会把整份代码写两遍：去掉围栏后，若首行（通常是 #include）或 int main 重复出现，截到第二份之前
function dedupeCode(raw: string) {
    let code = raw.replace(/^```[a-z+]*\s*\n/i, '').replace(/\n```[\s\S]*$/i, '').trim();
    const mains = [...code.matchAll(/\bint\s+main\s*\(/g)].map((m) => m.index!);
    if (mains.length > 1) {
        // 从第二个 main 往前找最近的 #include，作为第二份的起点
        const before = code.slice(0, mains[1]);
        const inc = before.lastIndexOf('#include');
        const cut = inc > mains[0] ? inc : mains[1];
        code = code.slice(0, cut).trim();
    }
    return `${code}\n`;
}

// 题面里的样例块
const SAMPLE_IN = /```input1\s*\n([\s\S]*?)```/;
const SAMPLE_OUT = /```output1\s*\n([\s\S]*?)```/;
const norm = (t: string) => t.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).join('\n').trim();

// 题面里混进推理过程的特征
const REASONING_HINTS = /让我们|让我|等等[，,]|重新检查|重新计算|算错|我将|我发现|不可能\)|是否我看错|难道/;

// ---------- go-judge 沙箱 ----------

class Sandbox {
    constructor(private url: string, private compileCmd: string) { }

    private async run(cmd: any) {
        const res = await fetch(`${this.url.replace(/\/+$/, '')}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd: [cmd] }),
            signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) throw new Error(`沙箱返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const [r] = await res.json() as any[];
        return r;
    }

    async compile(std: string) {
        const args = this.compileCmd.split(/\s+/).filter(Boolean);
        const r = await this.run({
            args,
            env: ['PATH=/usr/local/bin:/usr/bin:/bin'],
            files: [{ content: '' }, { name: 'stdout', max: 65536 }, { name: 'stderr', max: 65536 }],
            cpuLimit: 30e9, clockLimit: 60e9, memoryLimit: 1024 << 20, procLimit: 64,
            copyIn: { 'std.cpp': { content: std } },
            copyOut: ['stdout', 'stderr'],
            copyOutCached: ['std'],
        });
        if (r.status !== 'Accepted' || !r.fileIds?.std) {
            throw new Error(`标程编译失败：${(r.files?.stderr || r.error || r.status || '').slice(0, 1500)}`);
        }
        return r.fileIds.std as string;
    }

    async exec(fileId: string, input: string, timeMs: number, memoryMb: number) {
        const r = await this.run({
            args: ['std'],
            env: ['PATH=/usr/bin:/bin'],
            files: [{ content: input }, { name: 'stdout', max: 64 << 20 }, { name: 'stderr', max: 65536 }],
            cpuLimit: timeMs * 3 * 1e6, clockLimit: timeMs * 6 * 1e6, memoryLimit: memoryMb << 20, procLimit: 16,
            copyIn: { std: { fileId } },
            copyOut: ['stdout', 'stderr'],
        });
        return {
            ok: r.status === 'Accepted',
            status: r.status as string,
            stdout: (r.files?.stdout ?? '') as string,
            stderr: (r.files?.stderr ?? '') as string,
            timeMs: Math.round((r.time || 0) / 1e6),
        };
    }

    async free(fileId: string) {
        await fetch(`${this.url.replace(/\/+$/, '')}/file/${fileId}`, { method: 'DELETE' }).catch(() => { });
    }
}

export async function apply(ctx: Context, config: ReturnType<typeof Config>) {
    ctx.on('ready', async () => {
        await jobs.createIndex({ domainId: 1, createdAt: -1 });
    });

    // ---------- LLM ----------
    async function callLLM(system: string, user: string) {
        if (!config.baseUrl) throw new Error('还没有在 控制面板 → 配置管理 → hydro-ai-author 里填 AI 接口');
        const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(config.apiKey && config.apiKey !== API_KEY_PLACEHOLDER ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: config.model || undefined,
                messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                max_tokens: config.maxTokens,
                temperature: 0.7,
                stream: false,
                ...(config.enableThinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
            }),
            signal: AbortSignal.timeout(config.timeout * 1000),
        });
        if (!res.ok) throw new Error(`AI 接口返回 ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data: any = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error('AI 没有返回内容（可能 maxTokens 太小）');
        return String(content);
    }

    // ---------- 任务日志 ----------
    async function log(jobId: ObjectId, line: string) {
        await jobs.updateOne({ _id: jobId }, { $push: { log: `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}` }, $set: { updatedAt: new Date() } });
    }

    // ---------- 出一道题并入库，返回 docId ----------
    async function generateProblem(jobId: ObjectId, domainId: string, owner: number, spec: ProblemSpec, hidden: boolean): Promise<number> {
        await log(jobId, `请求 AI 出题：${spec.topic || '自由主题'}（难度 ${spec.difficulty}，${spec.cases} 组数据）…`);
        const raw = await callLLM(SYSTEM_PROMPT, buildUserPrompt(spec));
        const g = parseSections(raw);
        await log(jobId, `AI 返回：《${g.title}》，标签 ${g.tags.join('/') || '无'}，${g.tests.length} 组输入，限制 ${g.time}ms / ${g.memory}MB`);

        // 生成输出
        const outputs: string[] = [];
        if (config.sandboxUrl) {
            const sb = new Sandbox(config.sandboxUrl, config.compileCmd);
            await log(jobId, '沙箱编译标程…');
            let fid: string | null = null;
            for (let attempt = 0; attempt < 3 && !fid; attempt++) {
                try {
                    fid = await sb.compile(g.std);
                } catch (e: any) {
                    if (attempt === 2) throw e;
                    await log(jobId, `编译失败，请 AI 修正（第 ${attempt + 1} 次）：${e.message.split('\n')[0].slice(0, 200)}`);
                    const fixed = await callLLM(
                        '你是 C++ 专家。用户给出一份程序和它的编译错误，请输出修正后的完整程序。只输出代码，不要解释，不要 Markdown 围栏。',
                        `编译错误：\n${e.message.slice(0, 3000)}\n\n程序：\n${g.std}`,
                    );
                    g.std = dedupeCode(fixed.replace(/<think>[\s\S]*?<\/think>/g, ''));
                }
            }
            try {
                let fixes = 0;
                const MAX_FIXES = 4;
                for (let i = 0; i < g.tests.length; i++) {
                    const r = await sb.exec(fid!, g.tests[i], g.time, g.memory);
                    if (r.ok) {
                        outputs.push(r.stdout);
                        await log(jobId, `第 ${i + 1} 组：标程 ${r.timeMs}ms，输出 ${r.stdout.length} 字节`);
                        continue;
                    }
                    // 跑挂了：让 AI 决定是改数据还是改标程
                    if (fixes >= MAX_FIXES) {
                        await log(jobId, `第 ${i + 1} 组：${r.status}，修复次数用完，丢弃这组数据`);
                        g.tests.splice(i, 1); i--;
                        continue;
                    }
                    fixes++;
                    await log(jobId, `第 ${i + 1} 组：标程 ${r.status}（${r.timeMs}ms，限制 ${g.time}ms），请 AI 修正…`);
                    const reply = await callLLM(
                        `你是信息学竞赛命题人。标程在某组测试数据上运行失败，请判断原因并二选一给出修正：
- 如果是这组输入超出了题面数据范围、或规模过大导致标程无法在时限内完成，输出一组符合数据范围、规模明显更小但仍有意义的替换输入；
- 如果是标程本身有错或复杂度不达标，输出修正后的完整标程。
严格按以下格式之一输出，不要输出其他内容：
===INPUT===
（替换输入）
或
===STD===
（完整 C++17 程序，不要围栏）`,
                        `题目《${g.title}》，时限 ${g.time}ms，内存 ${g.memory}MB。
题面（含数据范围）：
${g.content.slice(0, 4000)}

失败信息：第 ${i + 1} 组，状态 ${r.status}，用时 ${r.timeMs}ms。stderr：${r.stderr.slice(0, 500)}
该组输入开头（共 ${g.tests[i].length} 字符）：
${g.tests[i].slice(0, 1500)}

当前标程：
${g.std}`,
                    );
                    const t = reply.replace(/<think>[\s\S]*?<\/think>/g, '');
                    const mInput = /===\s*INPUT\s*===\s*\n([\s\S]*)$/.exec(t);
                    const mStd = /===\s*STD\s*===\s*\n([\s\S]*)$/.exec(t);
                    if (mStd) {
                        g.std = dedupeCode(mStd[1]);
                        await log(jobId, 'AI 修改了标程，重新编译并从第 1 组重跑');
                        await sb.free(fid!);
                        fid = await sb.compile(g.std);
                        outputs.length = 0; i = -1;
                    } else if (mInput) {
                        g.tests[i] = mInput[1].replace(/\s+$/, '') + '\n';
                        await log(jobId, `AI 替换了第 ${i + 1} 组输入（${g.tests[i].length} 字符），重跑这组`);
                        i--;
                    } else {
                        await log(jobId, `AI 回复无法解析，丢弃第 ${i + 1} 组数据`);
                        g.tests.splice(i, 1); i--;
                    }
                }
                if (g.tests.length < 2) throw new Error('可用测试数据不足 2 组');
            } finally {
                if (fid) await sb.free(fid);
            }
        } else {
            throw new Error('没有配置沙箱地址，无法生成标准输出');
        }

        // 用标程结果校正题面里的样例输出
        if (config.sandboxUrl) {
            const mIn = SAMPLE_IN.exec(g.content);
            const mOut = SAMPLE_OUT.exec(g.content);
            if (mIn && mOut) {
                let expected: string | null = null;
                if (norm(mIn[1]) === norm(g.tests[0])) expected = outputs[0];
                else {
                    const sb = new Sandbox(config.sandboxUrl, config.compileCmd);
                    const fid2 = await sb.compile(g.std);
                    try {
                        const r = await sb.exec(fid2, `${norm(mIn[1])}\n`, g.time, g.memory);
                        if (r.ok) expected = r.stdout;
                    } finally { await sb.free(fid2); }
                }
                if (expected !== null && norm(expected) !== norm(mOut[1])) {
                    g.content = g.content.replace(SAMPLE_OUT, '```output1\n' + norm(expected) + '\n```');
                    await log(jobId, '题面样例输出与标程不一致，已按标程结果改正');
                }
            }
        }

        // 题面里混进了推理过程：让 AI 只重写题面
        if (REASONING_HINTS.test(g.content)) {
            await log(jobId, '题面疑似混入推理过程，请 AI 重写题面…');
            const rewritten = await callLLM(
                '你是信息学竞赛命题人。下面这份 Markdown 题面里混进了作者核对、推导、自我修正的草稿文字。请输出整理后的正式题面：保留全部小节和样例数据不变（样例输入输出一个字符都不能改），样例解释只保留结论性说明，删除所有推理、犹豫、检查过程。只输出 Markdown 题面，不要任何额外说明，不要围栏包住整体。',
                g.content,
            );
            const cleaned = rewritten.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*```(?:markdown|md)?\s*\n/i, '').replace(/\n```\s*$/i, '').trim();
            const oIn = SAMPLE_IN.exec(g.content)?.[1]; const nIn = SAMPLE_IN.exec(cleaned)?.[1];
            const oOut = SAMPLE_OUT.exec(g.content)?.[1]; const nOut = SAMPLE_OUT.exec(cleaned)?.[1];
            if (cleaned.length > 100 && oIn && nIn && norm(oIn) === norm(nIn) && oOut && nOut && norm(oOut) === norm(nOut)) {
                g.content = cleaned;
                await log(jobId, '题面已重写');
            } else {
                await log(jobId, '重写结果样例不一致，保留原题面，请人工检查');
            }
        }

        // 入库
        const docId = await ProblemModel.add(domainId, '', g.title, g.content, owner, g.tags, { hidden, difficulty: spec.difficulty } as any);
        const cfg = `time: ${g.time}ms\nmemory: ${g.memory}m\n`;
        await ProblemModel.addTestdata(domainId, docId, 'config.yaml', Buffer.from(cfg), owner);
        for (let i = 0; i < g.tests.length; i++) {
            await ProblemModel.addTestdata(domainId, docId, `${i + 1}.in`, Buffer.from(g.tests[i]), owner);
            await ProblemModel.addTestdata(domainId, docId, `${i + 1}.out`, Buffer.from(outputs[i]), owner);
        }
        await ProblemModel.addAdditionalFile(domainId, docId, 'std.cpp', Buffer.from(g.std), owner);
        await log(jobId, `已创建题目 P${docId}《${g.title}》${hidden ? '（隐藏，待审核）' : ''}`);
        return docId;
    }

    function parseSpecLines(text: string, difficulty: number, cases: number): ProblemSpec[] {
        // 每行一题：主题|难度   难度可省略
        return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
            const [topic, d] = l.split('|').map((s) => s.trim());
            return { topic, difficulty: Math.min(10, Math.max(1, +d || difficulty)), cases };
        });
    }

    async function runJob(jobId: ObjectId, fn: (jobId: ObjectId) => Promise<void>) {
        try {
            await fn(jobId);
            await jobs.updateOne({ _id: jobId }, { $set: { status: 'done', updatedAt: new Date() } });
        } catch (e: any) {
            await log(jobId, `出错：${e.message}`);
            await jobs.updateOne({ _id: jobId }, { $set: { status: 'error', error: e.message, updatedAt: new Date() } });
        }
    }

    async function newJob(domainId: string, uid: number, type: JobDoc['type'], title: string) {
        const doc: JobDoc = {
            _id: new ObjectId(), domainId, uid, type, status: 'running', title, log: [], pids: [], createdAt: new Date(), updatedAt: new Date(),
        };
        await jobs.insertOne(doc);
        return doc._id;
    }

    // ---------- Handlers ----------
    class AiAuthorHandler extends Handler {
        async prepare() {
            this.checkPerm(PERM.PERM_CREATE_PROBLEM);
        }

        async get() {
            const domainId = this.domain._id;
            const recent = await jobs.find({ domainId }).sort({ createdAt: -1 }).limit(20).toArray();
            this.response.body = { recent, configured: !!config.baseUrl, modelName: config.model };
            this.response.template = 'ai_author.html';
        }

        @param('topic', Types.String, true)
        @param('difficulty', Types.PositiveInt)
        @param('cases', Types.PositiveInt)
        @param('extra', Types.String, true)
        @param('count', Types.PositiveInt, true)
        async postProblem(domainId: string, topic = '', difficulty: number, cases: number, extra = '', count = 1) {
            count = Math.min(count, 10);
            cases = Math.min(cases, 30);
            const jobId = await newJob(domainId, this.user._id, 'problem', `出题：${topic || '自由主题'} ×${count}`);
            const owner = this.user._id;
            const hidden = config.hidden;
            runJob(jobId, async () => {
                let ok = 0;
                for (let i = 0; i < count; i++) {
                    let pid: number | null = null;
                    for (let attempt = 0; attempt < 2 && pid === null; attempt++) {
                        try {
                            pid = await generateProblem(jobId, domainId, owner, { topic, difficulty: Math.min(10, difficulty), cases, extra }, hidden);
                        } catch (e: any) {
                            await log(jobId, `第 ${i + 1} 题第 ${attempt + 1} 次生成失败：${e.message.split('\n')[0].slice(0, 200)}${attempt === 0 ? '，重试' : '，放弃'}`);
                        }
                    }
                    if (pid === null) continue;
                    ok++;
                    await jobs.updateOne({ _id: jobId }, { $push: { pids: pid } });
                }
                if (!ok) throw new Error('没有任何题目生成成功');
            });
            this.response.redirect = this.url('ai_author_job', { jid: jobId.toHexString() });
        }

        @param('title', Types.Title)
        @param('rule', Types.Range(['oi', 'acm', 'ioi', 'ledo', 'strictioi']))
        @param('beginAt', Types.String)
        @param('duration', Types.PositiveInt)
        @param('specs', Types.String, true)
        @param('difficulty', Types.PositiveInt)
        @param('cases', Types.PositiveInt)
        @param('pids', Types.String, true)
        @param('content', Types.String, true)
        async postContest(
            domainId: string, title: string, rule: string, beginAt: string, duration: number,
            specs = '', difficulty: number, cases: number, pidsText = '', content = '',
        ) {
            const begin = new Date(beginAt);
            if (Number.isNaN(begin.getTime())) throw new Error('开始时间格式不对');
            const end = new Date(begin.getTime() + duration * 60000);
            const specList = parseSpecLines(specs, difficulty, Math.min(cases, 30)).slice(0, 10);
            const existing = pidsText.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
            if (!specList.length && !existing.length) throw new Error('至少要有一道 AI 新题或一个已有题号');
            const jobId = await newJob(domainId, this.user._id, 'contest', `建比赛：${title}`);
            const owner = this.user._id;
            runJob(jobId, async () => {
                const pids: number[] = [];
                for (const p of existing) {
                    const pdoc = await ProblemModel.get(domainId, /^\d+$/.test(p) ? +p : p);
                    if (!pdoc) throw new Error(`题目 ${p} 不存在`);
                    pids.push(pdoc.docId);
                    await log(jobId, `使用已有题目 P${pdoc.docId}《${pdoc.title}》`);
                }
                for (const spec of specList) {
                    let pid: number | null = null;
                    for (let attempt = 0; attempt < 2 && pid === null; attempt++) {
                        try {
                            pid = await generateProblem(jobId, domainId, owner, spec, true);
                        } catch (e: any) {
                            await log(jobId, `「${spec.topic}」第 ${attempt + 1} 次生成失败：${e.message.split('\n')[0].slice(0, 200)}${attempt === 0 ? '，重试' : '，跳过这题'}`);
                        }
                    }
                    if (pid === null) continue;
                    pids.push(pid);
                    await jobs.updateOne({ _id: jobId }, { $push: { pids: pid } });
                }
                if (!pids.length) throw new Error('没有任何题目生成成功，比赛未创建');
                const desc = content || `${title}\n\n本场比赛由 AI 辅助命题。`;
                const tid = await ContestModel.add(domainId, title, desc, owner, rule, begin, end, pids, false);
                await jobs.updateOne({ _id: jobId }, { $set: { tid } });
                await log(jobId, `比赛已创建：${title}，${pids.length} 题，${begin.toLocaleString('zh-CN')} 开始，时长 ${duration} 分钟`);
            });
            this.response.redirect = this.url('ai_author_job', { jid: jobId.toHexString() });
        }
    }

    class AiAuthorJobHandler extends Handler {
        async prepare() {
            this.checkPerm(PERM.PERM_CREATE_PROBLEM);
        }

        @param('jid', Types.ObjectId)
        async get(domainId: string, jid: ObjectId) {
            const job = await jobs.findOne({ _id: jid, domainId });
            if (!job) throw new NotFoundError(jid);
            this.response.body = { job };
            this.response.template = 'ai_author_job.html';
        }
    }

    class AiAuthorJobStatusHandler extends Handler {
        async prepare() {
            this.checkPerm(PERM.PERM_CREATE_PROBLEM);
        }

        @param('jid', Types.ObjectId)
        async get(domainId: string, jid: ObjectId) {
            const job = await jobs.findOne({ _id: jid, domainId });
            if (!job) throw new NotFoundError(jid);
            this.response.body = {
                status: job.status, log: job.log, pids: job.pids, tid: job.tid ? job.tid.toString() : null, error: job.error,
            };
        }
    }

    ctx.Route('ai_author', '/ai-author', AiAuthorHandler, PERM.PERM_CREATE_PROBLEM);
    ctx.Route('ai_author_job', '/ai-author/job/:jid', AiAuthorJobHandler, PERM.PERM_CREATE_PROBLEM);
    ctx.Route('ai_author_job_status', '/ai-author/job/:jid/status', AiAuthorJobStatusHandler, PERM.PERM_CREATE_PROBLEM);
    ctx.injectUI('ProblemAdd', 'ai_author', { icon: 'add', text: 'AI 出题' });
    ctx.injectUI('Nav', 'ai_author', { prefix: 'ai-author' }, PERM.PERM_CREATE_PROBLEM);
}
