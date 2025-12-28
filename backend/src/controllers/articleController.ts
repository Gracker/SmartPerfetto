import { Request, Response } from 'express';
import { ArticleAggregator } from '../services/articleAggregator';

let articleAggregator: ArticleAggregator;

export function initArticleAggregator(): void {
  articleAggregator = new ArticleAggregator();

  // Listen for article updates
  articleAggregator.on('articles-updated', (articles) => {
    console.log(`Articles updated: ${articles.length} total`);
  });
}

// Get all articles with optional filtering
export async function getArticles(req: Request, res: Response): Promise<void> {
  try {
    const {
      category,
      tags,
      dateFrom,
      dateTo,
      source,
      query,
      page = 1,
      limit = 20,
    } = req.query;

    const filters: any = {};

    if (category) filters.category = category;
    if (tags) filters.tags = Array.isArray(tags) ? tags : [tags];
    if (source) filters.source = source;
    if (query) filters.query = query;
    if (dateFrom && dateTo) {
      filters.dateRange = {
        from: new Date(dateFrom as string),
        to: new Date(dateTo as string),
      };
    }

    const allArticles = articleAggregator.getArticles(filters);
    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;

    const paginatedArticles = allArticles.slice(startIndex, endIndex);

    res.json({
      articles: paginatedArticles,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: allArticles.length,
        pages: Math.ceil(allArticles.length / limitNum),
      },
    });
  } catch (error) {
    console.error('Error fetching articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
}

// Get a single article by ID
export async function getArticle(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const article = articleAggregator.getArticle(id);

    if (!article) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    res.json(article);
  } catch (error) {
    console.error('Error fetching article:', error);
    res.status(500).json({ error: 'Failed to fetch article' });
  }
}

// Search articles
export async function searchArticles(req: Request, res: Response): Promise<void> {
  try {
    const { q: query } = req.query;

    if (!query) {
      res.status(400).json({ error: 'Search query is required' });
      return;
    }

    const articles = await articleAggregator.searchArticles(query as string);

    res.json({ articles });
  } catch (error) {
    console.error('Error searching articles:', error);
    res.status(500).json({ error: 'Failed to search articles' });
  }
}

// Get article categories
export async function getCategories(req: Request, res: Response): Promise<void> {
  try {
    const categories = articleAggregator.getCategories();
    res.json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
}

// Get article tags
export async function getTags(req: Request, res: Response): Promise<void> {
  try {
    const tags = articleAggregator.getTags();
    res.json({ tags });
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
}

// Get article sources
export async function getSources(req: Request, res: Response): Promise<void> {
  try {
    const sources = articleAggregator.getSources();
    res.json({ sources });
  } catch (error) {
    console.error('Error fetching sources:', error);
    res.status(500).json({ error: 'Failed to fetch sources' });
  }
}

// Get article statistics
export async function getStats(req: Request, res: Response): Promise<void> {
  try {
    const stats = articleAggregator.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
}

// Add a new article (admin only)
export async function addArticle(req: Request, res: Response): Promise<void> {
  try {
    const article = await articleAggregator.addArticle(req.body);
    res.status(201).json(article);
  } catch (error) {
    console.error('Error adding article:', error);
    res.status(500).json({ error: 'Failed to add article' });
  }
}

// Force refresh articles (admin only)
export async function refreshArticles(req: Request, res: Response): Promise<void> {
  try {
    await articleAggregator.fetchArticles();
    res.json({ message: 'Articles refreshed successfully' });
  } catch (error) {
    console.error('Error refreshing articles:', error);
    res.status(500).json({ error: 'Failed to refresh articles' });
  }
}

// Get recommended articles based on content
export async function getRecommended(req: Request, res: Response): Promise<void> {
  try {
    const { limit = 5 } = req.query;
    const limitNum = parseInt(limit as string);

    // Get recent articles from various categories
    const categories = articleAggregator.getCategories();
    const recommended: any[] = [];

    for (const category of categories) {
      const articles = articleAggregator.getArticles({
        category,
        dateRange: {
          from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
          to: new Date(),
        },
      });

      if (articles.length > 0) {
        // Take the most recent article from each category
        recommended.push({
          category,
          article: articles[0],
        });
      }
    }

    // Sort by publication date and limit
    recommended.sort((a, b) =>
      new Date(b.article.publishedAt).getTime() - new Date(a.article.publishedAt).getTime()
    );

    res.json({
      recommended: recommended.slice(0, limitNum),
    });
  } catch (error) {
    console.error('Error getting recommendations:', error);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
}