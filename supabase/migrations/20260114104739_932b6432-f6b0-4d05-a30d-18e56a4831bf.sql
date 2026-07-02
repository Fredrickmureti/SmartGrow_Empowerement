-- AI Providers table - stores configuration for each AI provider
CREATE TABLE public.ai_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_code TEXT NOT NULL UNIQUE CHECK (provider_code IN ('openai', 'groq', 'gemini', 'openrouter', 'lovable')),
    display_name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    is_enabled BOOLEAN DEFAULT false,
    priority INTEGER DEFAULT 0,
    default_model TEXT,
    available_models JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- AI API Keys table - stores multiple API keys per provider with rotation support
CREATE TABLE public.ai_api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES public.ai_providers(id) ON DELETE CASCADE,
    key_name TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    is_enabled BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 0,
    rate_limit_hits INTEGER DEFAULT 0,
    last_rate_limited_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    total_requests INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- AI Usage Logs table - tracks all AI requests for analytics
CREATE TABLE public.ai_usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID REFERENCES public.ai_api_keys(id) ON DELETE SET NULL,
    provider_code TEXT NOT NULL,
    request_type TEXT NOT NULL,
    model_used TEXT,
    tokens_used INTEGER,
    was_rate_limited BOOLEAN DEFAULT false,
    was_fallback BOOLEAN DEFAULT false,
    error_message TEXT,
    response_time_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- AI Settings table - global AI configuration
CREATE TABLE public.ai_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    setting_key TEXT NOT NULL UNIQUE,
    setting_value TEXT,
    setting_type TEXT DEFAULT 'string',
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_settings ENABLE ROW LEVEL SECURITY;

-- RLS Policies - Only platform admins can manage AI configuration
CREATE POLICY "Platform admins can view AI providers" ON public.ai_providers
    FOR SELECT USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "Platform admins can manage AI providers" ON public.ai_providers
    FOR ALL USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "Platform admins can view AI keys" ON public.ai_api_keys
    FOR SELECT USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "Platform admins can manage AI keys" ON public.ai_api_keys
    FOR ALL USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "Platform admins can view AI usage logs" ON public.ai_usage_logs
    FOR SELECT USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "Service role can insert AI usage logs" ON public.ai_usage_logs
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Platform admins can view AI settings" ON public.ai_settings
    FOR SELECT USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "Platform admins can manage AI settings" ON public.ai_settings
    FOR ALL USING (public.is_platform_admin(auth.uid()));

-- Insert default providers
INSERT INTO public.ai_providers (provider_code, display_name, base_url, is_enabled, priority, default_model, available_models) VALUES
('lovable', 'Lovable AI (Built-in)', 'https://ai.gateway.lovable.dev/v1/chat/completions', true, 1, 'google/gemini-3-flash-preview', '["google/gemini-3-flash-preview", "google/gemini-2.5-pro", "google/gemini-2.5-flash", "openai/gpt-5", "openai/gpt-5-mini"]'::jsonb),
('openai', 'OpenAI', 'https://api.openai.com/v1/chat/completions', false, 2, 'gpt-4o', '["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"]'::jsonb),
('groq', 'Groq', 'https://api.groq.com/openai/v1/chat/completions', false, 3, 'llama-3.3-70b-versatile', '["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"]'::jsonb),
('gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', false, 4, 'gemini-2.0-flash', '["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"]'::jsonb),
('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1/chat/completions', false, 5, 'anthropic/claude-3.5-sonnet', '["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "meta-llama/llama-3.1-70b-instruct", "google/gemini-pro-1.5"]'::jsonb);

-- Insert default AI settings
INSERT INTO public.ai_settings (setting_key, setting_value, setting_type, description) VALUES
('ai_enabled', 'true', 'boolean', 'Enable or disable all AI features'),
('fallback_enabled', 'true', 'boolean', 'Enable automatic fallback to next provider on rate limit'),
('rate_limit_cooldown_seconds', '60', 'number', 'Seconds to wait before retrying a rate-limited key'),
('max_fallback_attempts', '3', 'number', 'Maximum number of fallback attempts before failing'),
('default_temperature', '0.7', 'number', 'Default temperature for AI responses'),
('expense_categorization_enabled', 'true', 'boolean', 'Enable AI expense categorization'),
('invoice_analysis_enabled', 'true', 'boolean', 'Enable AI invoice analysis'),
('financial_insights_enabled', 'true', 'boolean', 'Enable AI financial insights'),
('chat_enabled', 'true', 'boolean', 'Enable AI chat assistant');

-- Create indexes for performance
CREATE INDEX idx_ai_api_keys_provider_id ON public.ai_api_keys(provider_id);
CREATE INDEX idx_ai_api_keys_priority ON public.ai_api_keys(priority);
CREATE INDEX idx_ai_usage_logs_created_at ON public.ai_usage_logs(created_at);
CREATE INDEX idx_ai_usage_logs_provider ON public.ai_usage_logs(provider_code);

-- Trigger for updated_at
CREATE TRIGGER update_ai_providers_updated_at BEFORE UPDATE ON public.ai_providers
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_ai_api_keys_updated_at BEFORE UPDATE ON public.ai_api_keys
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_ai_settings_updated_at BEFORE UPDATE ON public.ai_settings
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();