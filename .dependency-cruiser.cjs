// 架构约束

//  规则                                     │ 作用
// ──────────────────────────────────────────┼─────────────────────────────────────────────
//  core 不能 import llm/tools/server/client │ 保证内核独立：Agent 内核不知道用的是 OpenAI还是 Anthropic、不知道是被 CLI 还是被 VSCode 调它
//  tools 不能 import llm/server/client      │ 工具层不关心结果渲染到终端还是网页
//  llm 不能 import tools/server/client      │ 模型适配层只暴露 LLMProvider 接口
//  server 不能 import client                │ 接入层不能反向依赖产品入口
//  全局禁止循环依赖                         │ —

// • 内核不知道自己被 CLI 还是被 VSCode 调用
// • 工具层不知道结果渲染到终端还是网页
// • 模型适配层只暴露接口，不关心调用方
// • 守住边界，IDE 插件 / 服务端 / 流水线只是给同一内核换外壳

// 跑 pnpm deps:check 来验证。未来加任何一行反向 import，CI都会卡住。
// 这就是「越靠内的层越稳定、越不知道外面是谁在用它」的工程化落地。

module.exports = {
    forbidden: [
        {
            name: "core-must-not-depend-on-outer-layers",
            severity: "error",
            from: { path: "^packages/core" },
            to: { path: "^packages/(llm|tools|server)|^client" },
        },
        {
            name: "tools-must-not-depend-on-llm-or-server-or-client",
            severity: "error",
            from: { path: "^packages/tools" },
            to: { path: "^packages/(llm|server)|^client" },
        },
        {
            name: "llm-must-not-depend-on-tools-or-server-or-client",
            severity: "error",
            from: { path: "^packages/llm" },
            to: { path: "^packages/(tools|server)|^client" },
        },
        {
            name: "server-must-not-depend-on-client",
            severity: "error",
            from: { path: "^packages/server" },
            to: { path: "^client" },
        },
        {
            name: "no-circular",
            severity: "error",
            from: {},
            to: { circular: true },
        },
    ],
    options: {
        tsConfig: { fileName: "tsconfig.base.json" },
        includeOnly: "^(packages|client)/.+",
        doNotFollow: { path: "node_modules" },
    },
};
