import axios from 'axios';
import { EventEmitter } from 'events';

export interface Article {
  id: string;
  title: string;
  url: string;
  author?: string;
  publishedAt: Date;
  summary: string;
  content: string;
  tags: string[];
  category: 'perfetto' | 'android' | 'performance' | 'tools' | 'best-practices';
  source: string;
  readingTime: number; // in minutes
}

export interface ArticleSource {
  id: string;
  name: string;
  baseUrl: string;
  rssUrl?: string;
  type: 'blog' | 'documentation' | 'news' | 'forum';
  isActive: boolean;
  lastFetched?: Date;
}

export interface ArticleFilters {
  category?: string;
  tags?: string[];
  dateRange?: {
    from: Date;
    to: Date;
  };
  source?: string;
  query?: string;
}

export class ArticleAggregator extends EventEmitter {
  private articles: Map<string, Article> = new Map();
  private sources: ArticleSource[] = [];
  private fetchInterval: NodeJS.Timeout | null = null;
  private readonly FETCH_INTERVAL = 60 * 60 * 1000; // 1 hour

  constructor() {
    super();
    this.initializeSources();
    this.startPeriodicFetch();
  }

  private initializeSources(): void {
    this.sources = [
      // Official Perfetto sources
      {
        id: 'perfetto-blog',
        name: 'Perfetto Official Blog',
        baseUrl: 'https://perfetto.dev',
        rssUrl: 'https://perfetto.dev/blog/feed.xml',
        type: 'blog',
        isActive: true,
      },
      {
        id: 'perfetto-docs',
        name: 'Perfetto Documentation',
        baseUrl: 'https://perfetto.dev/docs',
        type: 'documentation',
        isActive: true,
      },
      {
        id: 'perfetto-releases',
        name: 'Perfetto Releases',
        baseUrl: 'https://github.com/google/perfetto/releases',
        type: 'news',
        isActive: true,
      },

      // Android Performance sources
      {
        id: 'android-developers-blog',
        name: 'Android Developers Blog',
        baseUrl: 'https://android-developers.google.com',
        rssUrl: 'https://android-developers.google.com/feed',
        type: 'blog',
        isActive: true,
      },
      {
        id: 'android-performance-docs',
        name: 'Android Performance Docs',
        baseUrl: 'https://developer.android.com/topic/performance',
        type: 'documentation',
        isActive: true,
      },
      {
        id: 'medium-android-performance',
        name: 'Android Performance on Medium',
        baseUrl: 'https://medium.com/android-performance',
        rssUrl: 'https://medium.com/feed/android-performance',
        type: 'blog',
        isActive: true,
      },

      // General Performance sources
      {
        id: 'google-dev-blog',
        name: 'Google Developer Blog',
        baseUrl: 'https://developers.googleblog.com',
        rssUrl: 'https://developers.googleblog.com/feeds/posts/default',
        type: 'blog',
        isActive: true,
      },
      {
        id: 'proguard-blog',
        name: 'ProGuard Blog',
        baseUrl: 'https://proguard.blog',
        rssUrl: 'https://proguard.blog/feed',
        type: 'blog',
        isActive: true,
      },
    ];
  }

  public async fetchArticles(): Promise<void> {
    console.log('Starting article fetch...');

    for (const source of this.sources.filter(s => s.isActive)) {
      try {
        const articles = await this.fetchFromSource(source);
        this.processArticles(articles);
      } catch (error) {
        console.error(`Failed to fetch from ${source.name}:`, error);
      }
    }

    this.emit('articles-updated', this.getArticles());
    console.log(`Article fetch complete. Total articles: ${this.articles.size}`);
  }

  private async fetchFromSource(source: ArticleSource): Promise<Partial<Article>[]> {
    if (source.rssUrl) {
      return this.fetchRSSFeed(source);
    }

    switch (source.id) {
      case 'perfetto-docs':
        return this.fetchPerfettoDocs(source);
      case 'android-performance-docs':
        return this.fetchAndroidPerformanceDocs(source);
      case 'perfetto-releases':
        return this.fetchGitHubReleases(source);
      default:
        return [];
    }
  }

  private async fetchRSSFeed(source: ArticleSource): Promise<Partial<Article>[]> {
    try {
      const response = await axios.get(source.rssUrl!);
      const rssData = await this.parseRSS(response.data);
      return rssData;
    } catch (error) {
      console.error(`Failed to fetch RSS from ${source.name}:`, error);
      return [];
    }
  }

  private async parseRSS(xmlData: string): Promise<Partial<Article>[]> {
    // Simple RSS parser - in production, use a proper RSS parser
    const items: Partial<Article>[] = [];

    // Use regex to extract items (simplified approach)
    const itemRegex = /<item>(.*?)<\/item>/gs;
    const titleRegex = /<title>(.*?)<\/title>/;
    const linkRegex = /<link>(.*?)<\/link>/;
    const pubDateRegex = /<pubDate>(.*?)<\/pubDate>/;
    const descRegex = /<description>(.*?)<\/description>/;

    let match;
    while ((match = itemRegex.exec(xmlData)) !== null) {
      const itemContent = match[1];

      const titleMatch = titleRegex.exec(itemContent);
      const linkMatch = linkRegex.exec(itemContent);
      const pubDateMatch = pubDateRegex.exec(itemContent);
      const descMatch = descRegex.exec(itemContent);

      if (titleMatch && linkMatch) {
        items.push({
          title: this.cleanCDATA(titleMatch[1]),
          url: linkMatch[1],
          publishedAt: pubDateMatch ? new Date(pubDateMatch[1]) : new Date(),
          summary: descMatch ? this.stripHTML(this.cleanCDATA(descMatch[1])).substring(0, 200) : '',
        });
      }
    }

    return items;
  }

  private cleanCDATA(text: string): string {
    return text.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  }

  private stripHTML(html: string): string {
    return html.replace(/<[^>]*>/g, '');
  }

  private async fetchPerfettoDocs(source: ArticleSource): Promise<Partial<Article>[]> {
    // This would need to scrape or have an API for Perfetto docs
    // For now, return some default articles
    return [
      {
        title: 'Perfetto Quick Start Guide',
        url: 'https://perfetto.dev/docs/quickstart/',
        publishedAt: new Date(),
        summary: 'Get started with Perfetto tracing',
        category: 'perfetto' as const,
        source: source.name,
      },
      {
        title: 'Perfetto Configuration Guide',
        url: 'https://perfetto.dev/docs/concepts/config',
        publishedAt: new Date(),
        summary: 'Learn how to configure Perfetto traces',
        category: 'perfetto' as const,
        source: source.name,
      },
      {
        title: 'Perfetto SQL Reference',
        url: 'https://perfetto.dev/docs/analysis/sql-tables',
        publishedAt: new Date(),
        summary: 'Complete reference for Perfetto SQL',
        category: 'perfetto' as const,
        source: source.name,
      },
    ];
  }

  private async fetchAndroidPerformanceDocs(source: ArticleSource): Promise<Partial<Article>[]> {
    return [
      {
        title: 'Debugging UI Performance',
        url: 'https://developer.android.com/topic/performance/vitals/render',
        publishedAt: new Date(),
        summary: 'Learn to debug Android UI performance issues',
        category: 'android' as const,
        source: source.name,
      },
      {
        title: 'Memory Profiling',
        url: 'https://developer.android.com/topic/performance/memory',
        publishedAt: new Date(),
        summary: 'Profile and optimize app memory usage',
        category: 'android' as const,
        source: source.name,
      },
    ];
  }

  private async fetchGitHubReleases(source: ArticleSource): Promise<Partial<Article>[]> {
    try {
      const response = await axios.get(
        `https://api.github.com/repos/google/perfetto/releases`,
        {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
          },
        }
      );

      return response.data.slice(0, 10).map((release: any) => ({
        title: `Perfetto ${release.name} Released`,
        url: release.html_url,
        publishedAt: new Date(release.published_at),
        summary: this.stripHTML(release.body).substring(0, 200),
        category: 'perfetto' as const,
        source: source.name,
        tags: ['release', 'perfetto'],
      }));
    } catch (error) {
      console.error('Failed to fetch GitHub releases:', error);
      return [];
    }
  }

  private processArticles(articles: Partial<Article>[]): void {
    for (const article of articles) {
      if (!article.id && article.url) {
        article.id = this.generateId(article.url);
      }

      if (article.id && !this.articles.has(article.id)) {
        // Enrich the article
        const enrichedArticle: Article = {
          id: article.id!,
          title: article.title || 'Untitled',
          url: article.url!,
          author: article.author,
          publishedAt: article.publishedAt || new Date(),
          summary: article.summary || '',
          content: article.content || article.summary || '',
          tags: article.tags || [],
          category: article.category || 'android',
          source: article.source || 'Unknown',
          readingTime: article.readingTime || this.estimateReadingTime(article.summary || ''),
        };

        // Categorize automatically if not set
        if (!article.category) {
          enrichedArticle.category = this.categorizeArticle(enrichedArticle);
        }

        // Extract tags from title and summary
        if (enrichedArticle.tags.length === 0) {
          enrichedArticle.tags = this.extractTags(enrichedArticle);
        }

        this.articles.set(enrichedArticle.id, enrichedArticle);
      }
    }
  }

  private generateId(url: string): string {
    return Buffer.from(url).toString('base64').replace(/[+/=]/g, '');
  }

  private categorizeArticle(article: Article): Article['category'] {
    const text = (article.title + ' ' + article.summary).toLowerCase();

    if (text.includes('perfetto') || text.includes('trace')) {
      return 'perfetto';
    }
    if (text.includes('android') || text.includes('java')) {
      return 'android';
    }
    if (text.includes('performance') || text.includes('optimization')) {
      return 'performance';
    }
    if (text.includes('tool') || text.includes('utility')) {
      return 'tools';
    }

    return 'best-practices';
  }

  private extractTags(article: Article): string[] {
    const text = (article.title + ' ' + article.summary).toLowerCase();
    const tags = new Set<string>();

    // Common tags
    const tagMap: {[key: string]: string} = {
      'jank': 'UI Performance',
      'anr': 'ANR',
      'memory leak': 'Memory',
      'startup': 'Performance',
      'battery': 'Battery',
      'network': 'Network',
      'profiling': 'Profiling',
      'optimization': 'Optimization',
      'best practices': 'Best Practices',
      'debugging': 'Debugging',
      'trace': 'Tracing',
      'perfetto': 'Perfetto',
      'android': 'Android',
    };

    Object.entries(tagMap).forEach(([keyword, tag]) => {
      if (text.includes(keyword)) {
        tags.add(tag);
      }
    });

    return Array.from(tags);
  }

  private estimateReadingTime(text: string): number {
    // Average reading speed: 200 words per minute
    const wordsPerMinute = 200;
    const words = text.split(/\s+/).length;
    return Math.ceil(words / wordsPerMinute);
  }

  private startPeriodicFetch(): void {
    // Initial fetch
    this.fetchArticles();

    // Set up periodic fetch
    this.fetchInterval = setInterval(() => {
      this.fetchArticles();
    }, this.FETCH_INTERVAL);
  }

  public stopPeriodicFetch(): void {
    if (this.fetchInterval) {
      clearInterval(this.fetchInterval);
      this.fetchInterval = null;
    }
  }

  public getArticles(filters?: ArticleFilters): Article[] {
    let articles = Array.from(this.articles.values());

    if (!filters) {
      return articles.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    }

    // Apply filters
    if (filters.category) {
      articles = articles.filter(a => a.category === filters.category);
    }

    if (filters.tags && filters.tags.length > 0) {
      articles = articles.filter(a =>
        filters.tags!.some(tag => a.tags.includes(tag))
      );
    }

    if (filters.dateRange) {
      articles = articles.filter(a =>
        a.publishedAt >= filters.dateRange!.from &&
        a.publishedAt <= filters.dateRange!.to
      );
    }

    if (filters.source) {
      articles = articles.filter(a => a.source === filters.source);
    }

    if (filters.query) {
      const query = filters.query.toLowerCase();
      articles = articles.filter(a =>
        a.title.toLowerCase().includes(query) ||
        a.summary.toLowerCase().includes(query) ||
        a.tags.some(tag => tag.toLowerCase().includes(query))
      );
    }

    return articles.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  }

  public getArticle(id: string): Article | undefined {
    return this.articles.get(id);
  }

  public getCategories(): Article['category'][] {
    const categories = new Set<Article['category']>();
    this.articles.forEach(a => categories.add(a.category));
    return Array.from(categories);
  }

  public getTags(): string[] {
    const tags = new Set<string>();
    this.articles.forEach(a => a.tags.forEach(tag => tags.add(tag)));
    return Array.from(tags).sort();
  }

  public getSources(): ArticleSource[] {
    return this.sources;
  }

  public async addArticle(article: Omit<Article, 'id' | 'publishedAt'>): Promise<Article> {
    const id = this.generateId(article.url);
    const fullArticle: Article = {
      ...article,
      id,
      publishedAt: new Date(),
      readingTime: article.readingTime || this.estimateReadingTime(article.summary),
    };

    this.articles.set(id, fullArticle);
    this.emit('articles-updated', this.getArticles());

    return fullArticle;
  }

  public async searchArticles(query: string): Promise<Article[]> {
    // Simple search implementation - can be enhanced with full-text search
    const lowerQuery = query.toLowerCase();
    const results = Array.from(this.articles.values()).filter(article =>
      article.title.toLowerCase().includes(lowerQuery) ||
      article.summary.toLowerCase().includes(lowerQuery) ||
      article.content.toLowerCase().includes(lowerQuery) ||
      article.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
    );

    return results;
  }

  public getStats(): {
    totalArticles: number;
    articlesByCategory: {[key: string]: number};
    articlesBySource: {[key: string]: number};
    recentArticles: number;
  } {
    const articlesByCategory: {[key: string]: number} = {};
    const articlesBySource: {[key: string]: number} = {};
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    this.articles.forEach(article => {
      articlesByCategory[article.category] = (articlesByCategory[article.category] || 0) + 1;
      articlesBySource[article.source] = (articlesBySource[article.source] || 0) + 1;
    });

    const recentArticles = Array.from(this.articles.values()).filter(
      a => a.publishedAt > oneWeekAgo
    ).length;

    return {
      totalArticles: this.articles.size,
      articlesByCategory,
      articlesBySource,
      recentArticles,
    };
  }
}