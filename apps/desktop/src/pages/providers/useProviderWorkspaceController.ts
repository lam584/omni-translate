import { useRef, useState } from 'react';
import type { ProviderDraft, ProviderScenario } from '../../schema/config';
import type { ProviderProbeProfileRuntime, ProviderSmokeResult } from '../../schema/provider-runtime';
import type { ProviderTemplate } from '../../schema/provider-template';
import {
  readCustomProviderTemplates,
  type CustomProviderTemplateDraft,
} from '../../utils/custom-provider-templates';
import { readProviderTemplateCatalogPreferences, type ProviderTemplateCatalogPreference } from '../../utils/provider-template-catalog';
import {
  providersPageHelpers,
  type ModelCatalogScenarioFilter,
  type ModelCatalogState,
  type PendingModelRegistration,
} from './providersPageHelpers';

const {
  buildModelCatalogSignature,
  createDefaultCustomProviderDraft,
  createEmptyModelCatalog,
} = providersPageHelpers;

export function useProviderWorkspaceController(activeProvider: ProviderDraft) {
  const [customTemplates, setCustomTemplates] = useState<ProviderTemplate[]>(() => readCustomProviderTemplates());
  const [templateCatalogPreferences, setTemplateCatalogPreferences] = useState<ProviderTemplateCatalogPreference[]>(() => readProviderTemplateCatalogPreferences());
  const [secretDraft, setSecretDraft] = useState('');
  const [secretStored, setSecretStored] = useState(false);
  const [busyAction, setBusyAction] = useState<'secret' | 'secret-reveal' | 'verify' | null>(null);
  const [probeResult, setProbeResult] = useState<ProviderProbeProfileRuntime | null>(null);
  const [smokeResult, setSmokeResult] = useState<ProviderSmokeResult | null>(null);
  const [secretStatusMessage, setSecretStatusMessage] = useState<string | null>(null);
  const [secretVisible, setSecretVisible] = useState(false);
  const [sampleText, setSampleText] = useState('????????????????????');
  const [templateQuery, setTemplateQuery] = useState('');
  const [customProviderDialogOpen, setCustomProviderDialogOpen] = useState(false);
  const [customProviderDraft, setCustomProviderDraft] = useState<CustomProviderTemplateDraft>(() => createDefaultCustomProviderDraft());
  const [customProviderError, setCustomProviderError] = useState<string | null>(null);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [modelCatalogModalOpen, setModelCatalogModalOpen] = useState(false);
  const [capabilityRegistryModalOpen, setCapabilityRegistryModalOpen] = useState(false);
  const [audioModeHelpOpen, setAudioModeHelpOpen] = useState(false);
  const [verificationModalOpen, setVerificationModalOpen] = useState(false);
  const [selectedCatalogScenario, setSelectedCatalogScenario] = useState<ModelCatalogScenarioFilter>('all');
  const [modelCatalogTargetScenario, setModelCatalogTargetScenario] = useState<ProviderScenario>('watch');
  const [draggingTemplateId, setDraggingTemplateId] = useState<string | null>(null);
  const [draggingSceneModel, setDraggingSceneModel] = useState<{ scenario: ProviderScenario; modelId: string } | null>(null);
  const draggingTemplateIdRef = useRef<string | null>(null);
  const templateMouseDragMovedRef = useRef(false);
  const templateMouseHoverTargetRef = useRef<string | null>(null);
  const [manualModelIdDraft, setManualModelIdDraft] = useState('');
  const [pendingModelRegistration, setPendingModelRegistration] = useState<PendingModelRegistration | null>(null);
  const [modelCatalogQuery, setModelCatalogQuery] = useState('');
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogState>(() => createEmptyModelCatalog(buildModelCatalogSignature(activeProvider)));

  return {
    customTemplates, setCustomTemplates,
    templateCatalogPreferences, setTemplateCatalogPreferences,
    secretDraft, setSecretDraft, secretStored, setSecretStored,
    busyAction, setBusyAction, probeResult, setProbeResult, smokeResult, setSmokeResult,
    secretStatusMessage, setSecretStatusMessage, secretVisible, setSecretVisible,
    sampleText, setSampleText, templateQuery, setTemplateQuery,
    customProviderDialogOpen, setCustomProviderDialogOpen,
    customProviderDraft, setCustomProviderDraft, customProviderError, setCustomProviderError,
    advancedSettingsOpen, setAdvancedSettingsOpen,
    modelCatalogModalOpen, setModelCatalogModalOpen,
    capabilityRegistryModalOpen, setCapabilityRegistryModalOpen,
    audioModeHelpOpen, setAudioModeHelpOpen,
    verificationModalOpen, setVerificationModalOpen,
    selectedCatalogScenario, setSelectedCatalogScenario,
    modelCatalogTargetScenario, setModelCatalogTargetScenario,
    draggingTemplateId, setDraggingTemplateId,
    draggingSceneModel, setDraggingSceneModel,
    draggingTemplateIdRef, templateMouseDragMovedRef, templateMouseHoverTargetRef,
    manualModelIdDraft, setManualModelIdDraft,
    pendingModelRegistration, setPendingModelRegistration,
    modelCatalogQuery, setModelCatalogQuery,
    modelCatalog, setModelCatalog,
  };
}
