import type { FastifyInstance } from 'fastify';
import { t } from '@novelmaker/shared';
import type { AppContext } from '../app';
import { HttpError } from '../db';
import { indexNovel, indexStatus, searchNovel } from '../services/semantic';

export function registerSemanticRoutes(app: FastifyInstance, { db }: AppContext) {
  type P = { id: string };

  /** How much of the novel is indexed with the current embedding model. */
  app.get<{ Params: P }>('/api/novels/:id/semantic', async (req) => indexStatus(db, req.params.id));

  /** Brings the index up to date (only new or changed passages go to the model). */
  app.post<{ Params: P }>('/api/novels/:id/semantic/index', async (req) => indexNovel(db, req.params.id));

  /** Passages that mean something similar to the query, best first. */
  app.post<{ Params: P; Body: { query: string; k?: number; excludeSceneIds?: string[] } }>('/api/novels/:id/semantic/search', async (req) => {
    const query = req.body?.query?.trim();
    if (!query) throw new HttpError(400, t('Please enter a search text.'));
    const k = Math.min(Math.max(Number(req.body.k) || 10, 1), 50);
    return searchNovel(db, req.params.id, query, { k, minScore: 0.35, excludeSceneIds: req.body.excludeSceneIds });
  });
}
