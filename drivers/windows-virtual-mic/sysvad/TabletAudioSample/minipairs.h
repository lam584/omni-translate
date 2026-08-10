/*++

Copyright (c) Microsoft Corporation All Rights Reserved

Module Name:

    minipairs.h

Abstract:

    Omni virtual-speaker endpoint filter definition.

--*/

#ifndef _SYSVAD_MINIPAIRS_H_
#define _SYSVAD_MINIPAIRS_H_

#include "speakertopo.h"
#include "speakertoptable.h"
#include "speakerwavtable.h"
#include "micintopo.h"
#include "micintoptable.h"
#include "micinwavtable.h"

NTSTATUS
CreateMiniportWaveRTSYSVAD
(
    _Out_       PUNKNOWN *,
    _In_        REFCLSID,
    _In_opt_    PUNKNOWN,
    _In_        POOL_FLAGS,
    _In_        PUNKNOWN,
    _In_opt_    PVOID,
    _In_        PENDPOINT_MINIPAIR
);

NTSTATUS
CreateMiniportTopologySYSVAD
(
    _Out_       PUNKNOWN *,
    _In_        REFCLSID,
    _In_opt_    PUNKNOWN,
    _In_        POOL_FLAGS,
    _In_        PUNKNOWN,
    _In_opt_    PVOID,
    _In_        PENDPOINT_MINIPAIR
);

static struct
{
    KSAUDIO_PACKETSIZE_CONSTRAINTS2 TransportPacketConstraints;
    KSAUDIO_PACKETSIZE_PROCESSINGMODE_CONSTRAINT AdditionalProcessingConstraints[1];
} SysvadWaveRtPacketSizeConstraintsRender =
{
    {
        2 * HNSTIME_PER_MILLISECOND,
        FILE_BYTE_ALIGNMENT,
        0,
        2,
        {
            STATIC_AUDIO_SIGNALPROCESSINGMODE_DEFAULT,
            128,
            0,
        },
    },
    {
        {
            STATIC_AUDIO_SIGNALPROCESSINGMODE_MOVIE,
            1024,
            0,
        },
    }
};

const SYSVAD_DEVPROPERTY SysvadWaveFilterInterfacePropertiesRender[] =
{
    {
        &DEVPKEY_KsAudio_PacketSize_Constraints2,
        DEVPROP_TYPE_BINARY,
        sizeof(SysvadWaveRtPacketSizeConstraintsRender),
        &SysvadWaveRtPacketSizeConstraintsRender,
    },
};

static PHYSICALCONNECTIONTABLE SpeakerTopologyPhysicalConnections[] =
{
    {
        KSPIN_TOPO_WAVEOUT_SOURCE,
        KSPIN_WAVE_RENDER_SOURCE,
        CONNECTIONTYPE_WAVE_OUTPUT
    }
};

static ENDPOINT_MINIPAIR SpeakerMiniports =
{
    eSpeakerDevice,
    L"TopologySpeaker",
    NULL,
    CreateMiniportTopologySYSVAD,
    &SpeakerTopoMiniportFilterDescriptor,
    0, NULL,
    L"WaveSpeaker",
    NULL,
    CreateMiniportWaveRTSYSVAD,
    &SpeakerWaveMiniportFilterDescriptor,
    ARRAYSIZE(SysvadWaveFilterInterfacePropertiesRender),
    SysvadWaveFilterInterfacePropertiesRender,
    SPEAKER_DEVICE_MAX_CHANNELS,
    SpeakerPinDeviceFormatsAndModes,
    SIZEOF_ARRAY(SpeakerPinDeviceFormatsAndModes),
    SpeakerTopologyPhysicalConnections,
    SIZEOF_ARRAY(SpeakerTopologyPhysicalConnections),
    ENDPOINT_OFFLOAD_SUPPORTED,
    SpeakerModulesWaveFilter,
    SIZEOF_ARRAY(SpeakerModulesWaveFilter),
    &SpeakerModuleNotificationDeviceId,
};

static PHYSICALCONNECTIONTABLE MicInTopologyPhysicalConnections[] =
{
    {
        KSPIN_TOPO_BRIDGE,
        KSPIN_WAVE_BRIDGE,
        CONNECTIONTYPE_TOPOLOGY_OUTPUT
    }
};

static ENDPOINT_MINIPAIR MicInMiniports =
{
    eMicInDevice,
    L"TopologyMicIn",
    NULL,
    CreateMiniportTopologySYSVAD,
    &MicInTopoMiniportFilterDescriptor,
    0, NULL,
    L"WaveMicIn",
    NULL,
    CreateMiniportWaveRTSYSVAD,
    &MicInWaveMiniportFilterDescriptor,
    0, NULL,
    MICIN_DEVICE_MAX_CHANNELS,
    MicInPinDeviceFormatsAndModes,
    SIZEOF_ARRAY(MicInPinDeviceFormatsAndModes),
    MicInTopologyPhysicalConnections,
    SIZEOF_ARRAY(MicInTopologyPhysicalConnections),
    ENDPOINT_NO_FLAGS,
    NULL, 0, NULL,
};

static PENDPOINT_MINIPAIR g_RenderEndpoints[] =
{
    &SpeakerMiniports,
};

#define g_cRenderEndpoints (SIZEOF_ARRAY(g_RenderEndpoints))

static PENDPOINT_MINIPAIR g_CaptureEndpoints[] =
{
    &MicInMiniports,
};

#define g_cCaptureEndpoints (SIZEOF_ARRAY(g_CaptureEndpoints))

#define g_MaxMiniports ((g_cRenderEndpoints + g_cCaptureEndpoints) * 2)

#endif // _SYSVAD_MINIPAIRS_H_
