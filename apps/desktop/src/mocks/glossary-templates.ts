import type { GlossaryTemplate } from '../schema/glossary-template';

export const glossaryTemplates: GlossaryTemplate[] = [
  {
    id: 'glossary-template-watch',
    scenario: 'watch',
    label: '视频同传模板',
    description: '优先覆盖片名、人名、组织名和字幕风格常用词。',
    promptTemplateId: 'video-realtime-cn',
    boundPackageIds: ['glossary-video-default', 'community-anime-cn-v1'],
    strategy: 'scenario-first',
    rules: [
      {
        id: 'watch-scenario-template',
        source: 'scenario-template',
        priority: 1,
        note: '先注入视频场景模板中的固定提示与热词。',
      },
      {
        id: 'watch-user-package',
        source: 'user-package',
        priority: 2,
        note: '用户术语包覆盖默认模板中的通用词。',
      },
      {
        id: 'watch-community-package',
        source: 'community-package',
        priority: 3,
        note: '社区术语包作为补充，不覆盖用户显式条目。',
      },
    ],
  },
  {
    id: 'glossary-template-game',
    scenario: 'game',
    label: '游戏语音模板',
    description: '优先保留技能名、地图点位、战术缩写和房间热词。',
    promptTemplateId: 'game-live-translation-cn',
    boundPackageIds: ['glossary-game-team', 'community-discord-party-v1', 'game-discord-default'],
    strategy: 'user-first',
    rules: [
      {
        id: 'game-user-package',
        source: 'user-package',
        priority: 1,
        note: '先应用当前用户战队或小队术语包。',
      },
      {
        id: 'game-dictionary',
        source: 'game-dictionary',
        priority: 2,
        note: '再注入当前游戏房间词典和角色叫法。',
      },
      {
        id: 'game-community-package',
        source: 'community-package',
        priority: 3,
        note: '社区术语包补足公共缩写和流行说法。',
      },
    ],
  },
  {
    id: 'glossary-template-voice-room',
    scenario: 'voice-room',
    label: '语音房模板',
    description: '优先覆盖房间昵称、礼物词和高频社交表达。',
    promptTemplateId: 'voice-room-live-cn',
    boundPackageIds: ['community-discord-party-v1'],
    strategy: 'scenario-first',
    rules: [
      {
        id: 'voice-room-template',
        source: 'scenario-template',
        priority: 1,
        note: '先注入语音房场景常见表达。',
      },
      {
        id: 'voice-room-community-package',
        source: 'community-package',
        priority: 2,
        note: '社区术语包补足房间热词。',
      },
      {
        id: 'voice-room-user-package',
        source: 'user-package',
        priority: 3,
        note: '用户个人词条只覆盖显式指定条目。',
      },
    ],
  },
];

export const defaultGlossaryTemplate = glossaryTemplates[0];