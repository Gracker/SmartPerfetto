import { Request, Response } from 'express';
import AuthService from '../services/authService';
import { LoginRequest, RegisterRequest, ErrorResponse, AuthenticatedRequest } from '../types/auth';
import stripe from 'stripe';

class AuthController {
  private authService: AuthService;
  private stripeInstance?: stripe;

  constructor() {
    this.authService = new AuthService();

    // Initialize Stripe
    if (process.env.STRIPE_SECRET_KEY) {
      this.stripeInstance = new stripe(process.env.STRIPE_SECRET_KEY);
    }
  }

  register = async (req: Request, res: Response) => {
    try {
      const { email, password, name }: RegisterRequest = req.body;

      // 验证输入
      if (!email || !password || !name) {
        const error: ErrorResponse = {
          error: 'Missing required fields',
          details: 'Email, password, and name are required',
        };
        return res.status(400).json(error);
      }

      if (password.length < 6) {
        const error: ErrorResponse = {
          error: 'Invalid password',
          details: 'Password must be at least 6 characters long',
        };
        return res.status(400).json(error);
      }

      const result = await this.authService.register({ email, password, name });
      res.status(201).json(result);
    } catch (error) {
      console.error('Registration error:', error);
      const errorResponse: ErrorResponse = {
        error: 'Registration failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(400).json(errorResponse);
    }
  };

  login = async (req: Request, res: Response) => {
    try {
      const { email, password }: LoginRequest = req.body;

      // 验证输入
      if (!email || !password) {
        const error: ErrorResponse = {
          error: 'Missing required fields',
          details: 'Email and password are required',
        };
        return res.status(400).json(error);
      }

      const result = await this.authService.login({ email, password });
      res.json(result);
    } catch (error) {
      console.error('Login error:', error);
      const errorResponse: ErrorResponse = {
        error: 'Login failed',
        details: error instanceof Error ? error.message : 'Invalid credentials',
      };
      res.status(401).json(errorResponse);
    }
  };

  getProfile = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        const error: ErrorResponse = {
          error: 'User not authenticated',
        };
        return res.status(401).json(error);
      }

      const user = await this.authService.getUserById(req.user.id);
      if (!user) {
        const error: ErrorResponse = {
          error: 'User not found',
        };
        return res.status(404).json(error);
      }

      res.json({ user });
    } catch (error) {
      console.error('Get profile error:', error);
      const errorResponse: ErrorResponse = {
        error: 'Failed to get profile',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  createSubscriptionSession = async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user || !this.stripeInstance) {
        const error: ErrorResponse = {
          error: 'Not available',
          details: 'Subscription service is not available',
        };
        return res.status(503).json(error);
      }

      const { plan } = req.body;
      const priceId = plan === 'pro'
        ? process.env.STRIPE_PRO_PRICE_ID
        : process.env.STRIPE_ENTERPRISE_PRICE_ID;

      if (!priceId) {
        const error: ErrorResponse = {
          error: 'Invalid plan',
          details: 'Selected plan is not available',
        };
        return res.status(400).json(error);
      }

      const session = await this.stripeInstance.checkout.sessions.create({
        customer_email: req.user.email,
        billing_address_collection: 'auto',
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        success_url: `${process.env.FRONTEND_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL}/subscription/cancel`,
        metadata: {
          userId: req.user.id,
        },
      });

      res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
      console.error('Create subscription session error:', error);
      const errorResponse: ErrorResponse = {
        error: 'Failed to create subscription session',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
      res.status(500).json(errorResponse);
    }
  };

  handleWebhook = async (req: Request, res: Response) => {
    try {
      if (!this.stripeInstance || !process.env.STRIPE_WEBHOOK_SECRET) {
        return res.status(503).json({ error: 'Webhook not configured' });
      }

      const sig = req.headers['stripe-signature'];
      if (!sig) {
        return res.status(400).json({ error: 'No signature' });
      }

      const event = this.stripeInstance.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as stripe.Checkout.Session;
        const userId = session.metadata?.userId;

        if (userId) {
          const subscriptionType = (session as any).display_items?.[0]?.price?.lookup_key === 'pro' ? 'pro' : 'enterprise';
          await this.authService.updateUserSubscription(userId, subscriptionType as 'pro' | 'enterprise');
        }
      }

      res.json({ received: true });
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(400).json({ error: 'Webhook handler failed' });
    }
  };
}

export default AuthController;