/// 基准测试支持的实时协议类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BenchmarkProtocol {
    /// DashScope Omni 协议
    DashscopeOmni,
    /// DashScope LiveTranslate 协议
    DashscopeLiveTranslate,
    /// OpenAI Realtime Conversation 协议 (gpt-realtime 系列)
    OpenAiConversation,
    /// OpenAI Realtime Translation 协议 (/v1/realtime/translations)
    OpenAiTranslation,
    /// OpenAI Realtime Transcription 协议 (intent=transcription)
    OpenAiTranscription,
    /// OpenAI Flat 兼容协议 (GLM 等)
    OpenAiFlat,
    /// Gemini Live 协议
    GeminiLive,
}

impl BenchmarkProtocol {
    /// 是否属于 OpenAI 系列协议
    pub fn is_openai_family(self) -> bool {
        matches!(
            self,
            Self::OpenAiConversation
                | Self::OpenAiTranslation
                | Self::OpenAiTranscription
                | Self::OpenAiFlat
        )
    }

    /// 是否属于 DashScope 系列协议
    pub fn is_dashscope_family(self) -> bool {
        matches!(self, Self::DashscopeOmni | Self::DashscopeLiveTranslate)
    }

    /// 是否属于 Gemini 系列协议
    #[allow(dead_code)]
    pub fn is_gemini_family(self) -> bool {
        matches!(self, Self::GeminiLive)
    }

    /// 是否使用 manual commit 模式
    pub fn uses_manual_commit(self) -> bool {
        matches!(
            self,
            Self::DashscopeOmni | Self::OpenAiFlat | Self::OpenAiConversation
        )
    }

    /// 默认 base URL
    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::DashscopeOmni | Self::DashscopeLiveTranslate => {
                "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
            }
            Self::OpenAiConversation
            | Self::OpenAiTranslation
            | Self::OpenAiTranscription
            | Self::OpenAiFlat => "wss://api.openai.com/v1/realtime",
            Self::GeminiLive => "wss://generativelanguage.googleapis.com",
        }
    }

    /// 默认鉴权 header 名称
    pub fn default_auth_header(self) -> &'static str {
        match self {
            Self::DashscopeOmni
            | Self::DashscopeLiveTranslate
            | Self::OpenAiConversation
            | Self::OpenAiTranslation
            | Self::OpenAiTranscription
            | Self::OpenAiFlat => "Authorization",
            Self::GeminiLive => "x-goog-api-key",
        }
    }

    /// 默认鉴权 scheme
    pub fn default_auth_scheme(self) -> &'static str {
        match self {
            Self::DashscopeOmni
            | Self::DashscopeLiveTranslate
            | Self::OpenAiConversation
            | Self::OpenAiTranslation
            | Self::OpenAiTranscription
            | Self::OpenAiFlat => "bearer",
            // Gemini 直接传 API key，不加 Bearer 前缀
            Self::GeminiLive => "",
        }
    }

    /// 默认环境变量名
    pub fn default_env_var(self) -> &'static str {
        match self {
            Self::DashscopeOmni | Self::DashscopeLiveTranslate => "DASHSCOPE_API_KEY",
            Self::OpenAiConversation
            | Self::OpenAiTranslation
            | Self::OpenAiTranscription
            | Self::OpenAiFlat => "OPENAI_API_KEY",
            Self::GeminiLive => "GEMINI_API_KEY",
        }
    }

    /// 协议显示名称
    pub fn display_name(self) -> &'static str {
        match self {
            Self::DashscopeOmni => "dashscope-omni",
            Self::DashscopeLiveTranslate => "dashscope-livetranslate",
            Self::OpenAiConversation => "openai-conversation",
            Self::OpenAiTranslation => "openai-translation",
            Self::OpenAiTranscription => "openai-transcription",
            Self::OpenAiFlat => "openai-flat",
            Self::GeminiLive => "gemini-live",
        }
    }
}

/// 保留旧名以兼容已有代码
#[allow(dead_code)]
pub type DashscopeProtocol = BenchmarkProtocol;
