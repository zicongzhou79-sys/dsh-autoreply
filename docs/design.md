# QQ 自动回复 DSH 深度集成设计文档

## 1. 项目目标

将 QQ 自动回复重构为 DSH 的 QQ 消息适配插件。

AutoReply 负责 QQ 消息接入、消息展示、安全控制和受控发送；DSH 负责 Agent、模型、工具、会话、上下文和记忆管理。

回复内容、模型选择、Agent preset、工具调用和会话上下文均以 DSH 为唯一来源。

## 2. 总体架构

```text
QQ / NapCat
    ↓ OneBot 11 WebSocket
AutoReply 后端
    ├── 消息解析与归档
    ├── 会话绑定管理
    ├── 本地触发规则
    ├── 安全检查
    └── 受控消息发送
            ↓
       DSH Runtime
    ├── Workspace
    ├── Agent preset
    ├── Model
    ├── Tools
    ├── Session
    ├── Context
    └── Memory
```

消息处理流程：

```text
收到 QQ 消息
→ 解析并保存原始消息
→ 根据本地触发规则判断是否交给 DSH
→ 注入对应 DSH Session
→ DSH Agent 自主处理模型和工具
→ 返回结构化回复结果
→ AutoReply 执行安全检查
→ 通过 OneBot 发送
→ 保存回复结果和日志
```

## 3. 模块职责

### AutoReply

- 维护 NapCat / OneBot 连接。
- 解析私聊、群聊、@、引用和附件消息。
- 保存 QQ 原始消息及发送日志。
- 管理 QQ 会话与 DSH Session 的绑定关系。
- 执行私聊和群聊触发规则。
- 执行发送前安全检查、消息发送、失败记录和幂等控制。
- 提供 DSH 插件控制接口。

### DSH

- 管理 Workspace、Agent preset、模型及模型凭据。
- 管理工具注册、权限和调用。
- 管理 Session、历史上下文和长期记忆。
- 决定是否调用工具并生成最终回复内容。

AutoReply 不再自行拼接上下文、不再复制 Agent prompt、不再维护模型调用逻辑，也不再手动编排 DSH 工具。

## 4. 会话绑定

每个 QQ 对象可以绑定一个 DSH Session。

绑定流程：

1. 选择 DSH Workspace。
2. 选择 QQ 私聊对象或群聊对象。
3. 创建或选择 DSH Session。
4. 选择该会话使用的模型。
5. 选择该会话使用的 Agent preset。
6. 保存绑定。

会话管理支持：

- 查看已绑定会话。
- 启用或停用会话自动回复。
- 修改 Workspace、模型、Agent preset 和 Session。
- 删除会话绑定。

建议只保存 DSH 资源引用，不复制 DSH 内容：

```json
{
  "chat_key": "friend:10001",
  "workspace_id": "workspace-001",
  "dsh_session_id": "session-001",
  "model_id": "deepseek-chat",
  "agent_preset_id": "qq-personal-assistant",
  "enabled": true
}
```

## 5. 回复规则

界面中仅保留私聊和群聊触发设置。

### 私聊触发

- 自动回复全部私聊。
- 关闭私聊自动回复。

### 群聊触发

- 被 @ 时回复。
- 关键词命中时回复。
- 全部消息回复。
- 关闭群聊自动回复。

上下文条数、工具权限、记忆策略和模型行为由 DSH 管理，不在 AutoReply 界面中配置。

不提供上下文条数、回复频率、每日上限和敏感词配置。

## 6. 回复失败处理

当 DSH Agent、Session、模型或工具调用失败时：

- 不发送任何 QQ 消息。
- 在 AutoReply 本地日志中记录失败原因。
- 在模拟聊天或管理面板中显示错误信息。
- 错误信息仅供面板查看，不作为 AI 回复发送给 QQ。

示例：

```text
回复失败：DSH Agent 暂时不可用。
仅面板可见，未发送到 QQ。
```

## 7. UI 设计要求

正式界面必须与 `frontend-demo/index.html` 保持一致。

### 顶部固定操作栏

- 固定悬浮在页面顶部，页面滚动时始终可见。
- 包含 QQ 自动回复、运行状态、刷新按钮和关闭按钮。
- QQ 自动回复使用普通字号和字重。

### 运行状态

位于面板顶部，显示 OneBot 连接、QQ 登录、DSH 模型和 DSH 接入状态，每项使用状态灯和文字表示。

### QQ 登录

位于运行状态下方，扫码登录面板与操作按钮上下排列：

```text
QQ 登录
[扫码登录面板]

[启动服务] [重启服务] [打开 NapCat 登录管理]
```

三个操作按钮保持同一排，并使用紧凑尺寸。

### 会话绑定

替代原先的 DSH 运行配置区域，包含 Workspace、QQ 私聊或群聊对象、DSH Session、模型和 Agent preset 选择，以及绑定会话按钮和已绑定会话列表。

每条会话显示会话名称、私聊或群聊标识、DSH Session ID、Agent preset、启用开关和删除按钮。启用按钮和删除按钮位于同一排。

### 回复规则

只显示私聊触发和群聊触发，不显示模型参数、上下文条数、敏感词和限流配置。

### 模拟聊天

替代“今日统计”“最近回复”和独立会话列表，支持选择私聊或群聊会话、查看对方消息和 AI 回复。群聊中显示多个群成员的消息；DSH Agent 失败时显示错误状态，且错误信息只在面板显示，不发送到 QQ。

## 8. 数据管理

### AutoReply 本地保存

- QQ 原始消息。
- 消息方向、会话标识和附件元数据。
- 发送结果和回复日志。
- QQ 会话与 DSH Session 的绑定引用。

### DSH 保存

- Agent preset 内容。
- 模型配置。
- 工具配置。
- Session 上下文。
- Workspace 文件。
- 长期记忆。

AutoReply 不保存 DSH Agent 内容、模型凭据或工具实现副本。

## 9. 设计原则

- DSH 是唯一的智能回复运行时。
- AutoReply 是 QQ 通道和安全边界。
- 不重复实现 DSH 已有能力。
- 不在 AutoReply 和 DSH 之间复制上下文。
- 不发送未经安全检查的内容。
- DSH 失败时禁止发送空回复或错误提示。
- 界面保持与当前 Demo 一致。
- 所有后端功能改动必须进行自测并提交 Git 历史。

## 10. 验收标准

- UI 结构、布局、按钮位置和主要文字与 Demo 一致。
- 顶部操作栏滚动时始终可见。
- QQ 登录扫码区域与三个操作按钮上下排列。
- 会话绑定支持 Workspace、对象、Session、模型和 Agent preset。
- 会话支持启用、停用和删除。
- 规则只包含私聊和群聊触发设置。
- 群聊能够展示多个成员消息。
- DSH 回复失败时不发送 QQ 消息。
- 失败信息只在本地面板和日志中显示。
- 正常回复上下文、模型、工具和记忆均由 DSH 管理。
