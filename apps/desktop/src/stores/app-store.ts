import { create } from 'zustand';
import { audioRuntimeSnapshotMock } from '../defaults/audio-runtime';
import { appConfigDraftMock } from '../defaults/app-config';
import { navItems, presets } from '../defaults/app-content';
import { runtimeSnapshotMock } from '../defaults/runtime-shell';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type {
  AppConfigDraft,
  DeviceDraft,
  DiagnosticsDraft,
  DriverDraft,
  GlossaryDraft,
  OnboardingDraft,
  ProviderDraft,
  SpeechDraft,
  SubtitleDraft,
} from '../schema/config';
import type { RuntimeNotification, RuntimeSnapshot } from '../schema/runtime-core';
import {
  DEFAULT_SOURCE_TEXT_STYLE,
  DEFAULT_TRANSLATION_TEXT_STYLE,
  resolveOverlayTextStyle,
} from '../pages/overlay/overlayTypography';

type AppStoreState = {
  activePageId: string;
  activePresetId: string;
  configDraft: AppConfigDraft;
  runtimeSnapshot: RuntimeSnapshot;
  audioRuntimeSnapshot: AudioRuntimeSnapshot;
  runtimeNotifications: RuntimeNotification[];
  setActivePageByPath: (path: string) => void;
  setActivePresetId: (presetId: string) => void;
  setConfigDraft: (configDraft: AppConfigDraft) => void;
  setRuntimeSnapshot: (snapshot: RuntimeSnapshot) => void;
  setAudioRuntimeSnapshot: (snapshot: AudioRuntimeSnapshot) => void;
  pushRuntimeNotification: (notification: RuntimeNotification) => void;
  updateActiveProviderDraft: (patch: Partial<ProviderDraft>) => void;
  updateDeviceDraft: (patch: Partial<DeviceDraft>) => void;
  updateSubtitleDraft: (patch: Partial<SubtitleDraft>) => void;
  updateSpeechDraft: (patch: Partial<SpeechDraft>) => void;
  updateDriverDraft: (patch: Partial<DriverDraft>) => void;
  updateGlossaryDraft: (patch: Partial<GlossaryDraft>) => void;
  updateDiagnosticsDraft: (patch: Partial<DiagnosticsDraft>) => void;
  updateOnboardingDraft: (patch: Partial<OnboardingDraft>) => void;
  updateActiveProviderTemplateId: (templateId: string) => void;
  updateProviders: (providers: ProviderDraft[]) => void;
};

function resolveInitialPageId(items: typeof navItems) {
  return items[0]?.id ?? 'dashboard';
}

function resolveInitialPresetId(activePresetId: string | null | undefined, items: typeof presets) {
  return activePresetId ?? items[0]?.id ?? 'preset-watch-mode';
}

function resolvePageIdByPath(items: typeof navItems, path: string, fallbackPageId: string) {
  const matchedItem = items.find((item) => item.path === path) ?? items[0];
  return matchedItem?.id ?? fallbackPageId;
}

const defaultPageId = resolveInitialPageId(navItems);
const defaultPresetId = resolveInitialPresetId(appConfigDraftMock.onboarding.activePresetId, presets);

function mergeConfigDraftWithDefaults(configDraft: AppConfigDraft): AppConfigDraft {
  const incomingSubtitles = configDraft.subtitles as Partial<SubtitleDraft>;
  const legacyTextColor = incomingSubtitles.overlayTextColor ?? appConfigDraftMock.subtitles.overlayTextColor;
  return {
    ...appConfigDraftMock,
    ...configDraft,
    providers: configDraft.providers ?? appConfigDraftMock.providers,
    activeProviderTemplateId: configDraft.activeProviderTemplateId ?? appConfigDraftMock.activeProviderTemplateId,
    devices: {
      ...appConfigDraftMock.devices,
      ...configDraft.devices,
      inboundRoute: {
        ...appConfigDraftMock.devices.inboundRoute,
        ...configDraft.devices.inboundRoute,
        mixControl: {
          ...appConfigDraftMock.devices.inboundRoute.mixControl,
          ...configDraft.devices.inboundRoute?.mixControl,
        },
      },
      outboundRoute: {
        ...appConfigDraftMock.devices.outboundRoute,
        ...configDraft.devices.outboundRoute,
        mixControl: {
          ...appConfigDraftMock.devices.outboundRoute.mixControl,
          ...configDraft.devices.outboundRoute?.mixControl,
        },
      },
    },
    subtitles: {
      ...appConfigDraftMock.subtitles,
      ...configDraft.subtitles,
      history: {
        ...appConfigDraftMock.subtitles.history,
        ...incomingSubtitles.history,
      },
      overlaySourceTextStyle: resolveOverlayTextStyle(
        incomingSubtitles.overlaySourceTextStyle,
        DEFAULT_SOURCE_TEXT_STYLE,
        legacyTextColor,
      ),
      overlayTranslationTextStyle: resolveOverlayTextStyle(
        incomingSubtitles.overlayTranslationTextStyle,
        DEFAULT_TRANSLATION_TEXT_STYLE,
        legacyTextColor,
      ),
    },
    speech: {
      ...appConfigDraftMock.speech,
      ...configDraft.speech,
    },
    driver: {
      ...appConfigDraftMock.driver,
      ...configDraft.driver,
    },
    glossary: {
      ...appConfigDraftMock.glossary,
      ...configDraft.glossary,
    },
    diagnostics: {
      ...appConfigDraftMock.diagnostics,
      ...configDraft.diagnostics,
    },
    onboarding: {
      ...appConfigDraftMock.onboarding,
      ...configDraft.onboarding,
    },
  };
}

export const appStoreTestHelpers = {
  mergeConfigDraftWithDefaults,
  resolveInitialPageId,
  resolveInitialPresetId,
  resolvePageIdByPath,
};

export const useAppStore = create<AppStoreState>((set) => ({
  activePageId: defaultPageId,
  activePresetId: defaultPresetId,
  configDraft: appConfigDraftMock,
  runtimeSnapshot: runtimeSnapshotMock,
  audioRuntimeSnapshot: audioRuntimeSnapshotMock,
  runtimeNotifications: runtimeSnapshotMock.notifications,
  setActivePageByPath: (path) => {
    set({ activePageId: resolvePageIdByPath(navItems, path, defaultPageId) });
  },
  setActivePresetId: (presetId) =>
    set((state) => ({
      activePresetId: presetId,
      configDraft: {
        ...state.configDraft,
        onboarding: {
          ...state.configDraft.onboarding,
          activePresetId: presetId,
        },
      },
    })),
  setConfigDraft: (configDraft) =>
    set(() => {
      const mergedConfigDraft = mergeConfigDraftWithDefaults(configDraft);

      return {
        configDraft: mergedConfigDraft,
        activePresetId: mergedConfigDraft.onboarding.activePresetId,
      };
    }),
  setRuntimeSnapshot: (snapshot) =>
    set((state) => {
      // Native snapshots may lag notifications created locally between two IPC
      // reads. Merge by id instead of replacing the list so an unacknowledged
      // local error cannot disappear before the toast host renders it.
      const nativeIds = new Set(snapshot.notifications.map((item) => item.id));
      const notifications = [
        ...snapshot.notifications,
        ...state.runtimeNotifications.filter((item) => !nativeIds.has(item.id)),
      ].slice(0, 6);
      return {
        runtimeSnapshot: { ...snapshot, notifications },
        runtimeNotifications: notifications,
      };
    }),
  setAudioRuntimeSnapshot: (snapshot) =>
    set((state) => {
      // Discard stale out-of-order push events: the backend assigns a
      // monotonically increasing seq to every snapshot. A snapshot whose seq
      // is not newer than the one already in the store is stale (e.g. a
      // pre-clear event arriving after the clear invoke reply) and must be
      // dropped to prevent resurrecting cleared cues.
      const incomingSeq = snapshot.snapshotSeq ?? 0;
      const currentSeq = state.audioRuntimeSnapshot.snapshotSeq ?? 0;
      if (incomingSeq > 0 && incomingSeq <= currentSeq) {
        return state;
      }

      const sessionRunning = snapshot.inbound.streamBound || snapshot.outbound.streamBound;
      const previousSessionRunning =
        state.audioRuntimeSnapshot.inbound.streamBound || state.audioRuntimeSnapshot.outbound.streamBound;

      return {
        audioRuntimeSnapshot: {
          ...snapshot,
          sessionStartedAt: sessionRunning
            ? snapshot.sessionStartedAt ?? state.audioRuntimeSnapshot.sessionStartedAt ?? new Date().toISOString()
            : previousSessionRunning
              ? null
              : snapshot.sessionStartedAt,
        },
      };
    }),
  pushRuntimeNotification: (notification) =>
    set((state) => {
      const nextNotifications = [notification, ...state.runtimeNotifications.filter((item) => item.id !== notification.id)].slice(0, 6);

      return {
        runtimeNotifications: nextNotifications,
        runtimeSnapshot: {
          ...state.runtimeSnapshot,
          lastSyncAt: notification.emittedAt,
          notifications: nextNotifications,
        },
      };
    }),
  updateActiveProviderDraft: (patch) =>
    set((state) => {
      const templateId = state.configDraft.activeProviderTemplateId;
      const providers = state.configDraft.providers.map((p) =>
        p.templateId === templateId ? { ...p, ...patch } : p,
      );
      return {
        configDraft: { ...state.configDraft, providers },
      };
    }),
  updateDeviceDraft: (patch) =>
    set((state) => ({
      configDraft: {
        ...state.configDraft,
        devices: {
          ...state.configDraft.devices,
          ...patch,
        },
      },
    })),
  updateSubtitleDraft: (patch) =>
    set((state) => ({
      configDraft: {
        ...state.configDraft,
        subtitles: {
          ...state.configDraft.subtitles,
          ...patch,
        },
      },
    })),
  updateSpeechDraft: (patch) =>
    set((state) => ({
      configDraft: {
        ...state.configDraft,
        speech: {
          ...state.configDraft.speech,
          ...patch,
        },
      },
    })),
  updateDriverDraft: (patch) =>
    set((state) => ({
      configDraft: {
        ...state.configDraft,
        driver: {
          ...state.configDraft.driver,
          ...patch,
        },
      },
    })),
  updateGlossaryDraft: (patch) =>
    set((state) => ({
      configDraft: {
        ...state.configDraft,
        glossary: {
          ...state.configDraft.glossary,
          ...patch,
        },
      },
    })),
  updateDiagnosticsDraft: (patch) =>
    set((state) => ({
      configDraft: {
        ...state.configDraft,
        diagnostics: {
          ...state.configDraft.diagnostics,
          ...patch,
        },
      },
    })),
  updateOnboardingDraft: (patch) =>
    set((state) => ({
      configDraft: {
        ...state.configDraft,
        onboarding: {
          ...state.configDraft.onboarding,
          ...patch,
        },
      },
    })),
  updateActiveProviderTemplateId: (templateId) =>
    set((state) => ({
      configDraft: {
        ...state.configDraft,
        activeProviderTemplateId: templateId,
      },
    })),
  updateProviders: (providers) =>
    set((state) => ({
      configDraft: {
        ...state.configDraft,
        providers,
      },
    })),
}));
