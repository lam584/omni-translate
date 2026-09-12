import { describe, expect, it } from 'vitest';

import { providerTemplates } from '../defaults/provider-templates';
import { buildProviderDraftPatchFromTemplate } from '../utils/provider-draft';
import { appConfigDraftMock } from '../mocks/app-config';

function template(id: string) {
  const result = providerTemplates.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`missing template ${id}`);
  return result;
}

describe('provider manifest template projection', () => {
  it('exposes only models with enabled adapters', () => {
    const openai = template('template-openai-compatible-realtime');
    expect(openai.presetModels.map((preset) => preset.model)).toContain('gpt-realtime-2.1');
    expect(openai.presetModels.map((preset) => preset.model)).not.toContain('gpt-realtime-translate');

    const glm = template('template-zhipu-glm');
    expect(glm.presetModels.map((preset) => preset.model)).not.toContain('glm-realtime-flash');
    expect(glm.presetModels.map((preset) => preset.model)).toContain('glm-5.3-flash');
  });

  it('keeps Azure catalog model, deployment alias, auth and transport separate', () => {
    const azure = template('template-azure-openai');
    expect(azure.defaultDraft).toMatchObject({
      manifestProviderId: 'azure-openai',
      model: 'gpt-live-transcribe',
      deploymentId: '',
      transport: 'websocket',
      auth: { headerName: 'api-key', scheme: 'api-key' },
    });
    expect(azure.fieldGroups.flatMap((group) => group.fields).some((field) => (
      field.key === 'deploymentId'
    ))).toBe(true);
  });

  it('persists exact bindings and removes disabled models from scene assignments', () => {
    const openai = template('template-openai-compatible-realtime');
    const patch = buildProviderDraftPatchFromTemplate(appConfigDraftMock.providers[0], openai);
    expect(patch.modelProtocolBindings?.length).toBeGreaterThan(0);
    expect(patch.sceneModelAssignments?.flatMap((assignment) => assignment.modelIds))
      .not.toContain('gpt-realtime-translate');
  });
});
