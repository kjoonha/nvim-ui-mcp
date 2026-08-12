import type { NeovimSession } from './session.js';

export class SessionManager {
  #sessions = new Map<string, NeovimSession>();

  add(session: NeovimSession): NeovimSession {
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): NeovimSession {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`unknown session: ${id}`);
    return session;
  }

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  list(): NeovimSession[] {
    return [...this.#sessions.values()];
  }

  async close(id: string): Promise<void> {
    const session = this.get(id);
    await session.close();
    this.#sessions.delete(id);
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.list().map((session) => session.close()));
    this.#sessions.clear();
  }
}
