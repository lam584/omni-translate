import type { BrandContent, NavItem, Preset } from '../schema/content';

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
    id: 'diagnostics',
    label: '诊断与日志',
    hint: '',
    path: '/diagnostics',
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
