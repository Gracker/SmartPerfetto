import express from 'express';
import OpenAI from 'openai';
import { authenticate, checkUsage } from '../middleware/auth';

const router = express.Router();

// Lazy initialization of DeepSeek client to ensure dotenv loads first
let deepseek: OpenAI | null = null;

function getDeepSeekClient(): OpenAI | null {
  if (deepseek !== null) {
    return deepseek;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey) {
    deepseek = new OpenAI({
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    });
  }

  return deepseek;
}

function isMessageArray(value: unknown): value is OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return Array.isArray(value) && value.length > 0;
}

function resolveModel(providedModel?: string): string {
  return providedModel || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
}

function ensureApiKeyConfigured(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!process.env.SMARTPERFETTO_API_KEY) {
    res.status(503).json({
      success: false,
      error: 'Chat proxy authentication is not configured',
      details: 'Set SMARTPERFETTO_API_KEY to enable /chat routes safely',
    });
    return;
  }
  next();
}

// Align with other backend APIs: enforce auth + usage checks.
router.use(ensureApiKeyConfigured);
router.use(authenticate);
router.use(checkUsage(false));

// AI chat endpoint - supports OpenAI-compatible API
router.post('/chat', async (req, res) => {
  try {
    const { messages, model } = req.body || {};

    if (!isMessageArray(messages)) {
      return res.status(400).json({
        success: false,
        error: 'messages array is required'
      });
    }

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage?.content) {
      return res.status(400).json({
        success: false,
        error: 'Last message must have content'
      });
    }

    // Get DeepSeek client (lazy initialization)
    const client = getDeepSeekClient();
    if (!client) {
      return res.status(500).json({
        success: false,
        error: 'DeepSeek API not configured on server'
      });
    }

    // Call DeepSeek API
    const completion = await client.chat.completions.create({
      model: resolveModel(model),
      messages,
    });

    const response = completion.choices[0]?.message?.content || '';

    res.json({
      success: true,
      response,
      usage: completion.usage,
    });
  } catch (error: any) {
    console.error('Error in AI chat route:', error?.message || error);

    res.status(500).json({
      success: false,
      error: 'Failed to process chat request',
      details: error?.response?.data?.error?.message || error?.message,
    });
  }
});

// OpenAI-compatible completions endpoint for direct API compatibility
router.post('/completions', async (req, res) => {
  try {
    const { model, messages } = req.body || {};

    if (!isMessageArray(messages)) {
      return res.status(400).json({
        error: {
          message: 'messages array is required',
          type: 'invalid_request_error',
        }
      });
    }

    const client = getDeepSeekClient();
    if (!client) {
      return res.status(500).json({
        error: {
          message: 'DeepSeek API not configured on server',
          type: 'api_error',
        }
      });
    }

    // Call DeepSeek API
    const completion = await client.chat.completions.create({
      model: resolveModel(model),
      messages,
    });

    res.json(completion);
  } catch (error: any) {
    console.error('Error in /completions route:', error?.message || error);
    res.status(500).json({
      error: {
        message: error?.response?.data?.error?.message || error?.message || 'Failed to process request',
        type: 'api_error',
      }
    });
  }
});

export default router;
