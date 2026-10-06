/* eslint-disable no-undef */
// Reader UI state (JSON of ReaderPrefs); edited from the reader toolbar.
pref("__prefsPrefix__.readerPrefs", "");
// OpenAI-compatible API
pref("__prefsPrefix__.apiBase", "https://api.openai.com/v1");
pref("__prefsPrefix__.apiKey", "");
pref("__prefsPrefix__.apiModel", "gpt-4o-mini");
pref("__prefsPrefix__.apiConcurrency", 4);
// API providers (JSON list; replaces the single API above, which is migrated on first use)
pref("__prefsPrefix__.apiProviders", "");
// Local agent CLIs (path empty = auto-detect; model empty = the tool's own default).
// Effort defaults to medium: translation needs little reasoning and "high" is several times slower.
pref("__prefsPrefix__.grokPath", "");
pref("__prefsPrefix__.grokModel", "");
pref("__prefsPrefix__.grokEffort", "medium");
pref("__prefsPrefix__.codexPath", "");
pref("__prefsPrefix__.codexModel", "");
pref("__prefsPrefix__.codexEffort", "medium");
pref("__prefsPrefix__.claudePath", "");
pref("__prefsPrefix__.claudeModel", "");
pref("__prefsPrefix__.claudeEffort", "medium");
pref("__prefsPrefix__.agentConcurrency", 4);
pref("__prefsPrefix__.agentTimeoutSec", 300);
// Translation
pref("__prefsPrefix__.glossary", "");
pref("__prefsPrefix__.batchChars", 2600);
// MinerU parse store (empty = <Zotero data dir>/mineru-paper-store)
pref("__prefsPrefix__.mineruRoot", "");
// MinerU cloud API token (mineru.net → API 管理); used only when the reader asks for a parse
pref("__prefsPrefix__.mineruToken", "");
