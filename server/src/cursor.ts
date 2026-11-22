/** Authenticated pagination bound to a normalized request and source fence. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type ApiRequest, type Page } from '@agent-hub/domain';
import { HubError } from './errors.ts';

/** Source cursor, fence, mode and optional history watermark. */
export interface Position {
  at: string | number;
  fence: string | null;
  direction: 'older' | 'newer';
  through?: string;
  skip?: number;
}

/** Computes a compact digest over a stable projection or boundary. */
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

/** Issues continuations scoped to this process lifetime. */
export class Cursors {
  private readonly key = randomBytes(32);
  private readonly epoch = randomBytes(8).toString('base64url');

  /** Binds a token to a normalized query with independently encoded direction. */
  private scope(request: NonNullable<ApiRequest>): string {
    return digest(Object.entries(request).filter(([key]) => key !== 'cursor' && key !== 'direction').sort());
  }

  /** Encodes one authenticated producer or server position. */
  encode(request: NonNullable<ApiRequest>, position: Position): string {
    const data = Buffer.from(JSON.stringify([this.scope(request), position])).toString('base64url');
    if (data.length > 1900) throw new HubError('invalid_projection');
    return this.epoch + '.' + data + '.' + createHmac('sha256', this.key).update(data).digest('base64url');
  }

  /** Checks shape, authentication, scope and direction before any source read. */
  decode(request: NonNullable<ApiRequest>): Position | null {
    if (!('cursor' in request) || request.cursor === null) return null;
    const match = /^([A-Za-z0-9_-]{11})\.([A-Za-z0-9_-]{1,1900})\.([A-Za-z0-9_-]{43})$/.exec(request.cursor);
    if (!match) throw new HubError('invalid_request');
    const [, epoch, data, signature] = match;
    if (epoch !== this.epoch) throw new HubError('stale_boundary');
    const actual = createHmac('sha256', this.key).update(data).digest('base64url');
    if (!timingSafeEqual(Buffer.from(actual), Buffer.from(signature))) throw new HubError('invalid_request');
    const [scope, position] = JSON.parse(Buffer.from(data, 'base64url').toString()) as [string, Position];
    if (scope !== this.scope(request) || ('direction' in request && request.direction && request.direction !== position.direction)) {
      throw new HubError('invalid_request');
    }
    if (!(typeof position.at === 'string' && position.at.length <= 1024 || Number.isSafeInteger(position.at) && Number(position.at) >= 0)
      || !(position.fence === null || typeof position.fence === 'string' && position.fence.length <= 256)
      || !['older', 'newer'].includes(position.direction)
      || !(position.skip === undefined || Number.isSafeInteger(position.skip) && position.skip > 0 && position.skip <= 1000)
      || !(position.through === undefined || /^\d{1,20}$/.test(position.through))) throw new HubError('invalid_request');
    return position;
  }

  /** Slices deterministic inventory with an independent revision or projection fence. */
  slice<T>(request: NonNullable<ApiRequest>, position: Position | null, items: T[], fence: string, limit: number): { items: T[]; page: Page } {
    const offset = position ? Number(position.at) : 0;
    if (position && (position.fence !== fence || offset > items.length)) throw new HubError('stale_boundary');
    const end = offset + limit;
    return { items: items.slice(offset, end), page: {
      next: end < items.length ? this.encode(request, { at: end, fence, direction: 'newer' }) : null,
      previous: offset ? this.encode(request, { at: Math.max(0, offset - limit), fence, direction: 'older' }) : null,
      resume: null,
    } };
  }
}
