import type { ScenarioSupportProfile } from '../schema/scenario-support';

export const scenarioSupportProfiles: ScenarioSupportProfile[] = [
  {
    id: 'support-watch-system-audio',
    scenarioId: 'watch-system-audio',
    label: '看片系统音频采集',
    tier: 'stable',
    summary: '面向常规播放器和桌面系统输出采集，作为稳定支持默认场景。',
    criteria: [
      '系统输出采集可直接进入字幕链路。',
      '不依赖游戏专属注入或反作弊兼容处理。',
      '驱动异常时仍可保留字幕与本地扬声器输出。',
    ],
    diagnostics: [
      '优先检查系统播放设备与缓冲状态。',
      '延迟过高时保留字幕优先和本地播报降级。',
    ],
  },
  {
    id: 'support-voice-room',
    scenarioId: 'voice-room',
    label: '语音房与常规语音软件',
    tier: 'stable',
    summary: '面向常规语音软件、会议软件和普通语音房，允许麦克风出站翻译与虚拟麦克风输出。',
    criteria: [
      '麦克风链路和虚拟麦克风设备均可被系统识别。',
      '按键发言与持续监听配置可独立切换。',
      '驱动与桥接服务版本一致且健康状态为运行正常。',
    ],
    diagnostics: [
      '优先检查桥接服务握手和驱动版本。',
      '必要时回滚到同一批次驱动与 Bridge 版本。',
    ],
  },
  {
    id: 'support-game-party',
    scenarioId: 'game-party',
    label: '复杂游戏语音场景',
    tier: 'experimental',
    summary: '面向需要同时处理入站系统音频与出站麦克风的复杂游戏环境。',
    criteria: [
      '需要同时观察系统输出、麦克风和虚拟麦克风三条链路。',
      '可能受到独占模式、反作弊或第三方语音叠加影响。',
      '默认建议启用 Push-to-talk 与实验性支持提示。',
    ],
    diagnostics: [
      '先确认当前游戏是否允许虚拟麦克风与系统采集共存。',
      '若出现写入失败，优先切回字幕与本地监听模式。',
    ],
  },
];

export const defaultScenarioSupportProfile = scenarioSupportProfiles[0];