import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export function getConfiguredFrontendDistDir(): string | null {
  const configured = process.env.OPENDEEPSEA_FRONTEND_DIST?.trim();
  return configured ? resolve(configured) : null;
}

export function shouldServeFrontendFallback(path: string): boolean {
  return !(
    path === '/ws' ||
    path.startsWith('/api') ||
    path.startsWith('/uploads')
  );
}

export function getFrontendCacheControl(filePath: string): string {
  return basename(filePath) === 'index.html'
    ? 'no-store'
    : 'public, max-age=3600, immutable';
}

export function mountFrontendStatic(app: Express, frontendDistDir = getConfiguredFrontendDistDir()): void {
  if (!frontendDistDir) return;

  const indexPath = join(frontendDistDir, 'index.html');
  if (!existsSync(indexPath)) {
    console.warn(`[frontend] OPENDEEPSEA_FRONTEND_DIST is set but index.html was not found: ${indexPath}`);
    return;
  }

  app.use(express.static(frontendDistDir, {
    fallthrough: true,
    index: false,
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', getFrontendCacheControl(filePath));
    },
  }));
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (!shouldServeFrontendFallback(req.path)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', getFrontendCacheControl(indexPath));
    res.sendFile(indexPath, (err) => {
      if (err) next(err);
    });
  });
}
