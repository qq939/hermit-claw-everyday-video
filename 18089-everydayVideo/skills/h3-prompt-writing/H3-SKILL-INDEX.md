---
name: minimax-h3
description: 编排 MiniMax H3 视频生成任务 - 先用 h3-prompt-writing 重写提示词定妆/定场景/定道具，再用 H3 videos API 生成 4-15 秒 768p 音视频。支持 t2va / i2va / fl2va / l2va / ref2va 模式。本容器无 GPU，生成调用走 MiniMax Open Platform API。
---

# MiniMax H3 (deployed in this container)

## 本地能做什么

1. **重写分镜提示词** — 直接使用 `h3-prompt-writing` SKILL，按 base / ref 模式把自然语言改写为 H3 要求的 `integrated_multimodal_description` + `overall_soundscape` + `non_diegetic_music` 结构。
2. **调用视频生成 API** — 通过 `lib/h3/client.js` 提交 t2va / i2va / fl2va / l2va / ref2va 任务，轮询状态，下载 MP4。
3. **9 个视频风格模板** — `skills/*-generator/SKILL.md` 提供 3d-animation / brand-promo / papercraft / music-video 等 8 种风格的具体写法。

## 本地不能做什么

- 本容器无 GPU (`nvidia-smi` 缺失)，不能跑 33B Transformer 本地推理。
- 33B 模型权重需从 HuggingFace `MiniMaxAI/MiniMax-H3` 下载 (受出口带宽限制)，仓库本身仅含配置索引。
- 若用户要求"先图定妆定场景定道具，再用 gpu 生成 H3 视频"，"先生图"步骤用现有 `/ask/claude` 出图，"再生成视频"步骤调用 H3 API（外部 GPU 集群）。

## 最小调用样例

```js
const h3 = require('./lib/h3/client');
// 1. 改写提示词（用 h3-prompt-writing skill）
const prompt = `<改写后的 H3 prompt>`;
// 2. 提交任务
const { id } = await h3.createVideo({
    task: 't2va',          // 或 i2va / fl2va / l2va / ref2va
    prompt,
    target: { short_edge: 768, aspect_ratio: '16:9', duration_seconds: 10 },
    seed: 0,
}, process.env.H3_API_KEY);
// 3. 轮询
const status = await h3.getVideo(id, process.env.H3_API_KEY);
// 4. 下载
await h3.downloadVideo(id, '/home/agent/.claude/workspace/project/18089-everydayVideo/outputs/' + id + '.mp4', process.env.H3_API_KEY);
```

## 推荐工作流

1. 收到任务 → 用 `h3-prompt-writing` SKILL 重写提示词 (T2VA / FL2VA / Ref2VA)。
2. 若用户指定风格 → 加载对应 `*-generator` skill 注入风格提示。
3. 调 `h3.createVideo` 提交。
4. 轮询 `h3.getVideo` 直至 status=completed。
5. 调 `h3.downloadVideo` 落盘到 `outputs/<id>.mp4`。
6. 把分镜脚本 / prompt / 视频元数据沉淀进 `config/storyboard-projects.json` 与 `config/storyboard-shots.json`。
