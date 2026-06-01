import type { DriverInstallerPlan } from '../schema/driver-installation';
import type { BridgeStateSnapshot, DriverRepairAction } from '../schema/driver-bridge-contract';

export const driverStateSnapshotMock: BridgeStateSnapshot = {
  type: 'bridge.state.snapshot',
  requestId: 'bridge-state-query-default',
  protocolVersion: '2026-06-02',
  bridgeState: 'degraded',
  lifecycleState: 'error',
  driverHealth: 'version-mismatch',
  driverVersion: '0.8.1-dev',
  bridgeVersion: '0.1.0-skeleton',
  queuedFrames: 0,
  sourceFramesCaptured: 0,
  translatedFramesAccepted: 0,
  playbackFramesWritten: 0,
  underrunCount: 0,
  droppedFrameCount: 0,
  driverBufferedBytes: 0,
  driverMaxBufferedBytes: 19200,
  driverDroppedBytes: 0,
  sourcePendingBytes: 0,
  sourcePacerQueuedFrames: 0,
  monitorSourceQueuedFrames: 0,
  staleSourceFramesDropped: 0,
  monitorPlaybackState: 'idle',
  lastErrorCode: 'driver.version-mismatch',
};

export const driverHealthProfiles = [
  {
    id: 'driver-health-not-installed',
    state: 'not-installed',
    label: '未安装',
    tone: 'warning',
    note: '主程序尚未执行驱动安装，字幕链路仍可独立工作。',
  },
  {
    id: 'driver-health-damaged',
    state: 'damaged',
    label: '已损坏',
    tone: 'unsupported',
    note: '驱动文件或服务注册异常，需要进入回滚或重装。',
  },
  {
    id: 'driver-health-version-mismatch',
    state: 'version-mismatch',
    label: '版本不匹配',
    tone: 'warning',
    note: 'Bridge Service 与驱动版本不一致，需要优先回滚到同一版本。',
  },
  {
    id: 'driver-health-running',
    state: 'running',
    label: '运行正常',
    tone: 'ready',
    note: '驱动和 Bridge Service 版本一致，可承接译音输出。',
  },
] as const;

export const driverRepairActionsMock: Array<{
  id: DriverRepairAction;
  label: string;
  note: string;
}> = [
  {
    id: 'restart-bridge',
    label: '重启 Bridge Service',
    note: '用于服务未启动或 IPC 状态漂移。',
  },
  {
    id: 'rollback-driver',
    label: '回滚驱动版本',
    note: '用于版本不匹配或最近升级后写入失败。',
  },
  {
    id: 'reinstall-driver',
    label: '重新安装驱动',
    note: '用于驱动缺失或注册损坏。',
  },
  {
    id: 'open-diagnostics',
    label: '打开诊断详情',
    note: '用于导出日志、查看错误码和执行人工排查。',
  },
];

export const driverInstallerPlanMock: DriverInstallerPlan = {
  elevationTrigger: '当用户首次启用虚拟麦克风或点击修复动作时，桌面应用触发 UAC 提权。',
  installOrder: ['desktop-app', 'installer', 'driver', 'bridge-service', 'verification'],
  installSteps: [
    {
      id: 'install-step-elevation',
      title: '请求提权',
      actor: 'installer',
      detail: '安装器在写驱动文件和注册服务前统一请求管理员权限。',
      recoveryCondition: '用户拒绝提权时终止安装，保留字幕与本地播放降级路径。',
    },
    {
      id: 'install-step-driver',
      title: '写入驱动文件并注册',
      actor: 'driver',
      detail: '驱动文件先落到独立目录，再注册虚拟麦克风设备。',
      recoveryCondition: '写入失败时立即停止后续 Bridge Service 启动。',
    },
    {
      id: 'install-step-bridge',
      title: '启动 Bridge Service',
      actor: 'bridge-service',
      detail: 'Bridge Service 在驱动成功注册后启动，并执行最小握手。',
      recoveryCondition: '握手失败时进入 rollback-required，回收刚写入的安装产物。',
    },
    {
      id: 'install-step-verify',
      title: '执行状态校验',
      actor: 'desktop-app',
      detail: '桌面应用读取 Driver Bridge Contract 返回的版本和状态字段。',
      recoveryCondition: '若健康状态不是 running，则将结果写入 Diagnostics 并提示修复。',
    },
  ],
  rollbackSteps: [
    {
      id: 'rollback-step-stop-bridge',
      title: '先停 Bridge Service',
      actor: 'bridge-service',
      detail: '先停止用户态服务，避免仍有音频帧写入。',
      recoveryCondition: '若无法停止，保留错误码并阻止驱动文件删除。',
    },
    {
      id: 'rollback-step-remove-driver',
      title: '卸载驱动与注册信息',
      actor: 'driver',
      detail: '回滚时按注册顺序逆序清理驱动与设备节点。',
      recoveryCondition: '若删除失败，标记为 damaged 并要求人工修复。',
    },
    {
      id: 'rollback-step-restore-config',
      title: '恢复主程序状态',
      actor: 'desktop-app',
      detail: '主程序清理当前安装批次产生的配置快照和状态缓存。',
      recoveryCondition: '确保主程序回到字幕可用、译音关闭的降级状态。',
    },
  ],
  branchNotes: [
    {
      channel: 'development',
      notes: [
        '开发版允许测试签名驱动，但必须显式标记为开发环境。',
        '开发版日志默认保留更长时间，便于排查安装失败。',
      ],
    },
    {
      channel: 'release',
      notes: [
        '正式版必须使用正式签名驱动与受控安装包。',
        '正式版默认执行更严格的版本校验和回滚检查。',
      ],
    },
  ],
  errors: [
    {
      code: 'installer-elevation-denied',
      meaning: '用户拒绝管理员权限。',
      action: '保留主程序可用，提示稍后重试安装。',
    },
    {
      code: 'driver-registration-failed',
      meaning: '驱动注册或写入失败。',
      action: '中止 Bridge Service 启动并立即回滚。',
    },
    {
      code: 'bridge-handshake-timeout',
      meaning: 'Bridge Service 启动后未在窗口期内完成握手。',
      action: '执行回滚并保留日志以供 Diagnostics 导出。',
    },
  ],
};
