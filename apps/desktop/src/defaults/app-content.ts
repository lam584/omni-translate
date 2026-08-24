import type { BrandContent, NavItem, Preset, QuickSetupReadinessItem, TextListItem } from '../schema/content';

export const brandContent: BrandContent = {
  eyebrow: '',
  title: '实时翻译控制台',
  copy: '',
};

export const navItems: NavItem[] = [
  {
    id: 'session',
    label: '实时会话',
    hint: '',
    path: '/session',
  },
  {
    id: 'audio-routing',
    label: '音频路由',
    hint: '',
    path: '/audio-routing',
  },
  {
    id: 'glossary',
    label: '术语与词典',
    hint: '',
    path: '/glossary',
  },
  {
    id: 'history',
    label: '字幕历史',
    hint: '',
    path: '/history',
  },
  {
    id: 'diagnostics',
    label: '诊断与日志',
    hint: '',
    path: '/diagnostics',
  },
];

export const quickSetupSteps: TextListItem[] = [
  { id: 'check-system-audio', label: '确认系统音频、麦克风和输出设备。' },
  { id: 'select-provider-template', label: '选服务，填好地址和密钥。' },
  { id: 'choose-preset-mode', label: '选一个场景方案。' },
  { id: 'review-diagnostics', label: '看一遍诊断结果。' },
];

export const quickSetupReadinessItems: QuickSetupReadinessItem[] = [
  {
    id: 'readiness-devices',
    title: '音频路由先收敛',
    status: 'pending',
    description: '先把采集和输出设备定好。',
    route: '/audio-routing',
  },
  {
    id: 'readiness-provider-risk',
    title: '模型接入单独验证',
    status: 'risk',
    description: '在这里填地址、存密钥、跑测试。',
    route: '/providers',
  },
  {
    id: 'readiness-return-flow',
    title: '会话页负责运行态',
    status: 'complete',
    description: '运行时只看字幕、播报和事件。',
    route: '/session',
  },
];

export const providerRules: TextListItem[] = [
  { id: 'provider-rule-template-first', label: '优先用模板，不够再改高级项。' },
  {
    id: 'provider-rule-shared-fields',
    label: '常用服务共用基础项，差异项单独处理。',
  },
  {
    id: 'provider-rule-probing',
    label: '测试结果单独看，不和编辑区混在一起。',
  },
];

export const presets: Preset[] = [
  {
    id: 'preset-watch-mode',
    name: '看片模式',
    description: '抓取播放器或系统输出音频，实时翻译并展示双语字幕，译音可选。',
    chips: [
      { id: 'chip-system-audio', label: '系统音频' },
      { id: 'chip-bilingual-caption', label: '双语字幕' },
      { id: 'chip-low-interruption-tts', label: '低打扰播报' },
    ],
  },
  {
    id: 'preset-game-voice-mode',
    name: '游戏语音模式',
    description: '支持入站和出站双向翻译，保留原音、叠加译音，并对接虚拟麦克风。',
    chips: [
      { id: 'chip-bidirectional', label: '双向翻译' },
      { id: 'chip-ptt', label: '按键发言' },
      { id: 'chip-hotwords', label: '术语热词' },
    ],
  },
  {
    id: 'preset-discord-mode',
    name: '语音房模式',
    description: '面向语音房和社交协作，快速配置模型接入、监听设备和目标语言。',
    chips: [
      { id: 'chip-voice-room', label: '语音房' },
      { id: 'chip-template-config', label: '模板配置' },
      { id: 'chip-quick-switch', label: '快速切换' },
    ],
  },
];
