export type GlossaryScenario = 'watch' | 'game' | 'voice-room';

export type GlossaryProcessingMode = 'inject-all' | 'inject-important' | 'post-calibrate';

export type GlossaryInjectionSource = 'scenario-template' | 'user-package' | 'community-package' | 'game-dictionary';

export type GlossaryInjectionStrategy = 'scenario-first' | 'user-first';

export type GlossaryTemplateRule = {
  id: string;
  source: GlossaryInjectionSource;
  priority: number;
  note: string;
};

export type GlossaryTemplate = {
  id: string;
  scenario: GlossaryScenario;
  label: string;
  description: string;
  promptTemplateId: string;
  boundPackageIds: string[];
  strategy: GlossaryInjectionStrategy;
  rules: GlossaryTemplateRule[];
};