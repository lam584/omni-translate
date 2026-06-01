export type ScenarioSupportTier = 'stable' | 'experimental';

export type ScenarioSupportProfile = {
  id: string;
  scenarioId: string;
  label: string;
  tier: ScenarioSupportTier;
  summary: string;
  criteria: string[];
  diagnostics: string[];
};