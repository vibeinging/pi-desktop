# pi-eval

PI Desktop 的通用 Electron UI 评测骨架。它通过 CDP 启动或连接真实应用，再用鼠标、键盘和 DOM 断言验证界面。

## 运行

```bash
node eval/run.mjs
CDP_PORT=9223 node eval/run.mjs smoke
PI_EVAL_ISOLATED=1 node eval/run.mjs
```

每次运行会在 `eval/results/` 下生成 JSON 报告。

## 结构

```text
eval/
├── run.mjs
├── lib/
│   ├── cdp.mjs
│   ├── driver.mjs
│   ├── ui-driver.mjs
│   └── runner.mjs
└── tasks/
    └── 00-smoke.task.mjs
```

新业务项目可在 `driver.mjs` 中增加高层操作，再向 `tasks/` 添加独立任务。
