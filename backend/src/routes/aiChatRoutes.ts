import express from 'express';
import axios from 'axios';
import OpenAI from 'openai';

const router = express.Router();

// Lazy initialization of DeepSeek client to ensure dotenv loads first
let deepseek: OpenAI | null = null;

function getDeepSeekClient(): OpenAI | null {
  if (deepseek !== null) {
    return deepseek;
  }

  // Initialize on first call
  if (process.env.DEEPSEEK_API_KEY) {
    console.log('[aiChatRoutes] Initializing DeepSeek client');
    console.log('[aiChatRoutes] DEEPSEEK_BASE_URL:', process.env.DEEPSEEK_BASE_URL);
    deepseek = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    });
    console.log('[aiChatRoutes] DeepSeek client initialized successfully');
  } else {
    console.log('[aiChatRoutes] DEEPSEEK_API_KEY not found in environment');
  }

  return deepseek;
}

// Middleware to skip auth for AI chat
router.use((req, res, next) => {
  // Skip authentication for AI chat endpoint
  next();
});

// AI chat endpoint - supports OpenAI-compatible API
router.post('/chat', async (req, res) => {
  try {
    const { messages, provider = 'deepseek', model } = req.body;

    // Support both old format (message) and new format (messages array)
    const userMessages = messages || [{ role: 'user', content: req.body.message || '' }];

    if (!userMessages.length || !userMessages[userMessages.length - 1]?.content) {
      return res.status(400).json({
        success: false,
        error: 'No message provided'
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
      model: model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      messages: userMessages,
    });

    const response = completion.choices[0]?.message?.content || '';

    res.json({
      success: true,
      response,
      usage: completion.usage,
    });
  } catch (error: any) {
    console.error('Error in AI chat:', error?.response?.data || error?.message);

    // Return detailed error for debugging
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
    const { model, messages } = req.body;

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
      model: model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      messages,
    });

    res.json(completion);
  } catch (error: any) {
    console.error('Error in completions:', error?.response?.data || error?.message);
    res.status(500).json({
      error: {
        message: error?.response?.data?.error?.message || error?.message || 'Failed to process request',
        type: 'api_error',
      }
    });
  }
});

export default router;