# Bridge Service

这个模块是虚拟麦克风的用户态桥接层。

当前职责：

1. 通过 Windows named pipe 暴露 Driver Bridge Contract。
2. 承接主程序到驱动的音频写入关系，并记录最小运行日志。
3. 基于安装状态文件回报驱动版本、健康度与桥接生命周期。

当前不做：

1. 真实驱动内核态写入优化。
2. 驱动级性能调优。
3. 正式版 Windows Service 注册。

本地运行：

1. npm run build:bridge-service
2. npm run start --workspace @omni/bridge-service -- --pipe-name omni-bridge-ipc

测试覆盖：

1. bridge.init / bridge.state.query / bridge.frame.write / bridge.shutdown
2. named pipe IPC 握手与状态快照

验证命令：

1. npm run check:bridge-service
2. npm run build:bridge-service