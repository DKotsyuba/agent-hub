/** Deterministic synthetic records; structured observations are separate from original source prose. */
import type { MessageKey } from './locales';

/** Execution states remain distinct, including missing observations. */
export type AgentStatus = 'running' | 'succeeded' | 'failed' | 'unknown';
/** A synthetic execution linked by stable project, worktree and optional pool IDs. */
export interface Agent {
  /** Stable demo identity, never a live execution ID. */
  id: string;
  /** Human-readable task. */
  name: string;
  /** Related project ID. */
  project: string;
  /** Related worktree ID. */
  worktree: string;
  /** Related pool ID, absent for independent tasks. */
  pool?: string;
  /** Last observed execution state. */
  status: AgentStatus;
  /** Demonstration model label. */
  model: string;
  /** Observed elapsed milliseconds; null means unavailable, never a ticking estimate. */
  durationMs: number | null;
  /** ISO 8601 timestamp of the last observed activity. */
  observedAt: string;
  /** Last observed action. */
  activity: string;
  /** Plain-text result or explanation of its absence. */
  result: string;
}
/** A saved plan and an explicitly dated approximate estimate. */
export interface Project {
  /** Stable link key. */
  id: string;
  /** Ecosystem product name. */
  name: string;
  /** One-sentence purpose. */
  description: string;
  /** Saved, ordered plan. */
  plan: string[];
  /** Observed outcome, separate from the plan. */
  outcome: string;
  /** Saved approximate plan progress recorded on the observation date. */
  progress: {
    /** Saved count of approximately completed stages. */
    completed: number;
    /** Number of stages in the saved plan. */
    total: number;
    /** ISO 8601 timestamp of that source estimate. */
    observedAt: string;
  };
}
/** A read-only synthetic working directory observation. */
export interface Worktree {
  /** Stable link key. */
  id: string;
  /** Readable directory label. */
  name: string;
  /** Related project ID. */
  project: string;
  /** Demonstration branch. */
  branch: string;
  /** Demonstration filesystem path; never inspected. */
  path: string;
  /** Responsible role. */
  owner: string;
  /** Observation, with unknown coverage retained. */
  cleanliness: 'modified' | 'clean' | 'unknown' | 'tracked-only';
  /** Observed changed file count; null when coverage cannot establish a count. */
  modifiedFileCount: number | null;
  /** Fixture size semantics: complete measurement, lower bound or no measurement. */
  sizeKind: 'known' | 'lower-bound' | 'unmeasured';
  /** Saved byte measurement; null precisely when unmeasured. */
  sizeBytes: number | null;
  /** ISO 8601 timestamp of size observation, including an explicitly missing measurement. */
  sizeObservedAt: string;
  /** ISO 8601 timestamp of the last observed activity. */
  observedAt: string;
}
/** Saved vote evidence is independent of the member's Run execution state. */
export interface PoolVote {
  /** Run agent ID or the exact native member name. */
  member: string;
  /** Explicit saved vote; unknown means no observed vote, never an inferred abstention. */
  state: 'ready' | 'block' | 'unknown';
  /** Plain-text saved evidence, not derived from execution completion. */
  evidence: string;
  /** Explicit ISO 8601 demonstration observation timestamp. */
  observedAt: string;
}
/** Independent collaboration record; acceptance never implies execution completion. */
export interface Pool {
  /** Stable link key. */
  id: string;
  /** Readable purpose. */
  name: string;
  /** Related project ID. */
  project: string;
  /** Source adapter, including legacy provenance. */
  source: 'agent-pool' | 'agent-run-legacy';
  /** Explicit collaboration state. */
  state: 'discussion' | 'accepted-open' | 'attention' | 'awaiting-observation';
  /** Leader shown separately from participants. */
  leader: string;
  /** Linked Run executions; native members are listed separately. */
  agents: string[];
  /** Native-only members without Run history. */
  native: string[];
  /** Saved member votes with independent evidence and observation times. */
  votes: PoolVote[];
  /** Accepted decision, independent of closure. */
  decision: string;
  /** Delivery observation, independent of execution completion. */
  delivery: string;
}
/** A synthetic service observation, never a live availability claim. */
export interface Tool {
  /** Stable link key. */
  id: string;
  /** Ecosystem service name. */
  name: string;
  /** Authored fixture purpose key; live source prose must remain separate. */
  purpose: MessageKey;
  /** Authored fixture state label key. */
  state: MessageKey;
  /** Plain version value; the presentation layer supplies the localized demo disclosure. */
  version: string;
  /** Independent freshness/coverage label for the saved limit observation. */
  quotaState: 'known' | 'stale' | 'unknown' | 'not-applicable';
  /** Authored fixture coverage key; values are separate structured observations. */
  quota: MessageKey;
  /** Authored fixture diagnostic key; not an arbitrary service response. */
  detail: MessageKey;
  /** Numeric fixture observations interpolated only into known UI metadata. */
  metrics: Record<string, number>;
  /** Explicit ISO timestamps for reset/incident clock labels. */
  timestamps: Record<string, string>;
  /** Original observation timestamp, independent of simulated freshness. */
  observedAt: string;
}
/** Shared ISO observation timestamp; freshness is displayed independently. */
export const observed = "2026-10-20T10:42:00+02:00";

/** Saved source plans with structured, dated approximate progress. */
export const projects: Project[] = [
  {
    "id": "run",
    "name": "Agent Run",
    "description": "Исполнения агентов и история задач",
    "plan": [
      "Проверить завершение фоновых задач",
      "Уточнить сообщения о потерянном соединении",
      "Проверить восстановление истории"
    ],
    "outcome": "Сохранена история завершённых запусков. Один сценарий восстановления требует проверки.",
    "progress": {
      "completed": 2,
      "total": 3,
      "observedAt": "2026-10-20T10:30:00+02:00"
    }
  },
  {
    "id": "ide",
    "name": "Agent IDE",
    "description": "Контекст кода и точные изменения",
    "plan": [
      "Проверить индекс символов",
      "Проверить диагностику TypeScript",
      "Подготовить результаты проверки"
    ],
    "outcome": "Индекс готов. Проверка TypeScript выявила несовместимый контракт.",
    "progress": {
      "completed": 1,
      "total": 3,
      "observedAt": "2026-10-20T10:25:00+02:00"
    }
  },
  {
    "id": "pool",
    "name": "Agent Pool",
    "description": "Совместная работа и принятые решения",
    "plan": [
      "Согласовать протокол участников",
      "Проверить приёмку результатов",
      "Сохранить отдельный статус решения"
    ],
    "outcome": "Протокол согласован, пул остаётся открытым до завершения всех участников.",
    "progress": {
      "completed": 2,
      "total": 3,
      "observedAt": "2026-10-20T10:32:00+02:00"
    }
  },
  {
    "id": "hub",
    "name": "Agent Hub",
    "description": "Спокойный обзор всей экосистемы",
    "plan": [
      "Собрать читаемый интерфейс",
      "Проверить светлую и тёмную темы",
      "Передать макет на визуальное согласование"
    ],
    "outcome": "Подготовлен интерактивный макет с демонстрационными данными.",
    "progress": {
      "completed": 1,
      "total": 3,
      "observedAt": "2026-10-20T10:20:00+02:00"
    }
  }
];

/** Synthetic working directories with numeric measurements and explicit observation coverage. */
export const worktrees: Worktree[] = [
  {
    "id": "wt-hub-ui",
    "name": "Интерфейс обзора",
    "project": "hub",
    "branch": "prototype/readable-ui",
    "path": "/demo/agent-hub/readable-ui",
    "owner": "Разработчик интерфейса",
    "sizeKind": "known",
    "cleanliness": "modified",
    "modifiedFileCount": 4,
    "sizeBytes": 88290099,
    "observedAt": "2026-10-20T10:42:00+02:00",
    "sizeObservedAt": "2026-10-20T10:42:00+02:00"
  },
  {
    "id": "wt-hub-a11y",
    "name": "Доступность макета",
    "project": "hub",
    "branch": "review/keyboard",
    "path": "/demo/agent-hub/keyboard",
    "owner": "Ревьюер",
    "sizeKind": "lower-bound",
    "cleanliness": "clean",
    "modifiedFileCount": 0,
    "sizeBytes": 13212058,
    "observedAt": "2026-10-20T10:35:00+02:00",
    "sizeObservedAt": "2026-10-20T10:35:00+02:00"
  },
  {
    "id": "wt-run-jobs",
    "name": "Фоновые исполнения",
    "project": "run",
    "branch": "fix/job-lifecycle",
    "path": "/demo/agent-run/job-lifecycle",
    "owner": "Разработчик исполнения",
    "sizeKind": "known",
    "cleanliness": "modified",
    "modifiedFileCount": 2,
    "sizeBytes": 122473677,
    "observedAt": "2026-10-20T10:41:00+02:00",
    "sizeObservedAt": "2026-10-20T10:41:00+02:00"
  },
  {
    "id": "wt-run-history",
    "name": "История запусков",
    "project": "run",
    "branch": "feat/history",
    "path": "/demo/agent-run/history",
    "owner": "Разработчик истории",
    "sizeKind": "known",
    "cleanliness": "clean",
    "modifiedFileCount": 0,
    "sizeBytes": 95734989,
    "observedAt": "2026-10-20T10:29:00+02:00",
    "sizeObservedAt": "2026-10-20T10:29:00+02:00"
  },
  {
    "id": "wt-ide-index",
    "name": "Индекс проекта",
    "project": "ide",
    "branch": "feat/symbol-index",
    "path": "/demo/agent-ide/symbol-index",
    "owner": "Разработчик индекса",
    "sizeKind": "lower-bound",
    "cleanliness": "clean",
    "modifiedFileCount": 0,
    "sizeBytes": 214433792,
    "observedAt": "2026-10-20T10:38:00+02:00",
    "sizeObservedAt": "2026-10-20T10:38:00+02:00"
  },
  {
    "id": "wt-ide-types",
    "name": "Контракты типов",
    "project": "ide",
    "branch": "fix/type-contract",
    "path": "/demo/agent-ide/type-contract",
    "owner": "Проверка типов",
    "sizeKind": "unmeasured",
    "cleanliness": "unknown",
    "modifiedFileCount": null,
    "sizeBytes": null,
    "observedAt": "2026-10-20T10:31:00+02:00",
    "sizeObservedAt": "2026-10-20T10:31:00+02:00"
  },
  {
    "id": "wt-pool-protocol",
    "name": "Протокол участников",
    "project": "pool",
    "branch": "feat/member-protocol",
    "path": "/demo/agent-pool/member-protocol",
    "owner": "Разработчик протокола",
    "sizeKind": "known",
    "cleanliness": "modified",
    "modifiedFileCount": 3,
    "sizeBytes": 48339354,
    "observedAt": "2026-10-20T10:40:00+02:00",
    "sizeObservedAt": "2026-10-20T10:40:00+02:00"
  },
  {
    "id": "wt-pool-review",
    "name": "Приёмка результатов",
    "project": "pool",
    "branch": "review/delivery",
    "path": "/demo/agent-pool/delivery",
    "owner": "Ревьюер",
    "sizeKind": "unmeasured",
    "cleanliness": "tracked-only",
    "modifiedFileCount": null,
    "sizeBytes": null,
    "observedAt": "2026-10-20T10:33:00+02:00",
    "sizeObservedAt": "2026-10-20T10:33:00+02:00"
  }
];

/** Original task and result prose with numeric durations and ISO observation times. */
export const agents: Agent[] = [
  {
    "id": "a1",
    "name": "Собрать читаемый обзор",
    "project": "hub",
    "worktree": "wt-hub-ui",
    "pool": "p1",
    "status": "running",
    "model": "GPT-6.1",
    "activity": "Проверяет адаптивную компоновку",
    "result": "Результат ещё не передан. Агент проверяет макет в двух размерах окна.",
    "durationMs": 1080000,
    "observedAt": "2026-10-20T10:42:00+02:00"
  },
  {
    "id": "a2",
    "name": "Проверить завершение задач",
    "project": "run",
    "worktree": "wt-run-jobs",
    "pool": "p4",
    "status": "running",
    "model": "GPT-6",
    "activity": "Проверяет отмену фоновой задачи",
    "result": "Результат ещё не передан. Завершение фоновой задачи проверяется отдельно от приёмки результата.",
    "durationMs": 720000,
    "observedAt": "2026-10-20T10:41:00+02:00"
  },
  {
    "id": "a3",
    "name": "Согласовать протокол участников",
    "project": "pool",
    "worktree": "wt-pool-protocol",
    "pool": "p2",
    "status": "running",
    "model": "GPT-6.1",
    "activity": "Уточняет поведение повторной доставки",
    "result": "Промежуточный результат принят. Исполнение продолжается: проверяются повторные доставки.",
    "durationMs": 1440000,
    "observedAt": "2026-10-20T10:40:00+02:00"
  },
  {
    "id": "a4",
    "name": "Проверить контракты TypeScript",
    "project": "ide",
    "worktree": "wt-ide-types",
    "pool": "p3",
    "status": "failed",
    "model": "GPT-6",
    "activity": "Проверка остановлена: несовместимый тип",
    "result": "Проверка не пройдена. В демонстрационном контракте поле observation допускает null, а вызывающий код ожидает строку. Требуется уточнение контракта.",
    "durationMs": 420000,
    "observedAt": "2026-10-20T10:31:00+02:00"
  },
  {
    "id": "a5",
    "name": "Восстановить историю исполнения",
    "project": "run",
    "worktree": "wt-run-history",
    "pool": "p4",
    "status": "unknown",
    "model": "GPT-6",
    "activity": "Последнее наблюдение: ожидание ответа",
    "result": "Итог неизвестен. После последнего наблюдения сведения об исполнении не поступали. Это не подтверждает ни ошибку, ни завершение.",
    "durationMs": null,
    "observedAt": "2026-10-20T10:29:00+02:00"
  },
  {
    "id": "a6",
    "name": "Проверить клавиатурную навигацию",
    "project": "hub",
    "worktree": "wt-hub-a11y",
    "pool": "p1",
    "status": "succeeded",
    "model": "GPT-6.1",
    "activity": "Результат сохранён",
    "result": "Проверены порядок фокуса, переход к содержимому и возврат из деталей. Диалоги доступны с клавиатуры. Это демонстрационный отчёт, не результат проверки работающего сервиса.",
    "durationMs": 540000,
    "observedAt": "2026-10-20T10:35:00+02:00"
  },
  {
    "id": "a7",
    "name": "Обновить индекс символов",
    "project": "ide",
    "worktree": "wt-ide-index",
    "pool": "p3",
    "status": "succeeded",
    "model": "GPT-6",
    "activity": "Индекс подготовлен",
    "result": "Индекс демонстрационного проекта подготовлен. Обнаружено 146 символов в 23 файлах. Неподдерживаемые файлы исключены из покрытия.",
    "durationMs": 300000,
    "observedAt": "2026-10-20T10:38:00+02:00"
  },
  {
    "id": "a8",
    "name": "Проверить приёмку результата",
    "project": "pool",
    "worktree": "wt-pool-review",
    "pool": "p2",
    "status": "succeeded",
    "model": "GPT-6.1",
    "activity": "Приёмка отделена от завершения",
    "result": "Приёмка результата и завершение исполнения показаны раздельно. Принятое решение не закрывает пул автоматически.",
    "durationMs": 660000,
    "observedAt": "2026-10-20T10:33:00+02:00"
  },
  {
    "id": "a9",
    "name": "Сохранить последние результаты",
    "project": "run",
    "worktree": "wt-run-history",
    "status": "succeeded",
    "model": "GPT-6",
    "activity": "Сводка сохранена",
    "result": "Сводка сохранена с исходным источником и временем наблюдения. Неизвестные состояния не заменяются успешными.",
    "durationMs": 360000,
    "observedAt": "2026-10-20T10:26:00+02:00"
  },
  {
    "id": "a10",
    "name": "Уточнить подписи интерфейса",
    "project": "hub",
    "worktree": "wt-hub-ui",
    "status": "succeeded",
    "model": "GPT-6.1",
    "activity": "Русские подписи проверены",
    "result": "Технические идентификаторы перенесены в подробности. Основные действия и состояния подписаны по-русски.",
    "durationMs": 240000,
    "observedAt": "2026-10-20T10:24:00+02:00"
  },
  {
    "id": "a11",
    "name": "Проверить границы индекса",
    "project": "ide",
    "worktree": "wt-ide-index",
    "status": "running",
    "model": "GPT-6",
    "activity": "Проверяет исключённые файлы",
    "result": "Результат ещё не передан. Проверяется покрытие индекса без чтения исключённых файлов.",
    "durationMs": 480000,
    "observedAt": "2026-10-20T10:39:00+02:00"
  },
  {
    "id": "a12",
    "name": "Описать принятые решения",
    "project": "pool",
    "worktree": "wt-pool-review",
    "pool": "p2",
    "status": "succeeded",
    "model": "GPT-6.1",
    "activity": "Решение записано",
    "result": "Принято: показывать лидера отдельно от списка участников; сохранять происхождение прежних пулов Agent Run.",
    "durationMs": 180000,
    "observedAt": "2026-10-20T10:21:00+02:00"
  }
];

/** Independent collaboration records; enum IDs never depend on the interface language. */
export const pools: Pool[] = [
  {
    "id": "p1",
    "name": "Читаемый интерфейс",
    "project": "hub",
    "source": "agent-pool",
    "state": "discussion",
    "leader": "Координатор макета",
    "agents": [
      "a1",
      "a6"
    ],
    "native": [
      "Дизайн-ревьюер"
    ],
    "votes": [
      {
        "member": "a1",
        "state": "ready",
        "evidence": "Компоновка согласована по сохранённому макету; исполнение ещё работает.",
        "observedAt": "2026-10-20T10:30:00+02:00"
      },
      {
        "member": "a6",
        "state": "unknown",
        "evidence": "Голос не наблюдался. Завершение исполнения не заменяет голос.",
        "observedAt": "2026-10-20T10:35:00+02:00"
      },
      {
        "member": "Дизайн-ревьюер",
        "state": "block",
        "evidence": "Нужно проверить читаемость длинных заголовков при увеличении текста.",
        "observedAt": "2026-10-20T10:36:00+02:00"
      }
    ],
    "decision": "Принято в 10:20: приоритет читаемости, без панели управления сервисами.",
    "delivery": "Отчёт о доступности принят в 10:36. Основное исполнение продолжается."
  },
  {
    "id": "p2",
    "name": "Протокол совместной работы",
    "project": "pool",
    "source": "agent-pool",
    "state": "accepted-open",
    "leader": "Координатор протокола",
    "agents": [
      "a3",
      "a8",
      "a12"
    ],
    "native": [
      "Эксперт протокола"
    ],
    "votes": [
      {
        "member": "a3",
        "state": "ready",
        "evidence": "Контракт независимой приёмки проверен; дополнительные проверки продолжаются.",
        "observedAt": "2026-10-20T10:31:00+02:00"
      },
      {
        "member": "a8",
        "state": "ready",
        "evidence": "Проверена отдельная запись о приёмке.",
        "observedAt": "2026-10-20T10:30:00+02:00"
      },
      {
        "member": "a12",
        "state": "ready",
        "evidence": "Источник решения сохранён.",
        "observedAt": "2026-10-20T10:29:00+02:00"
      },
      {
        "member": "Эксперт протокола",
        "state": "ready",
        "evidence": "Протокол согласован по демонстрационному документу.",
        "observedAt": "2026-10-20T10:32:00+02:00"
      }
    ],
    "decision": "Принято в 10:32: приёмка результата не означает завершения агента.",
    "delivery": "Промежуточная поставка a3 принята в 10:34; агент ещё работает. Два итоговых отчёта сохранены."
  },
  {
    "id": "p3",
    "name": "Контекст и диагностика",
    "project": "ide",
    "source": "agent-pool",
    "state": "attention",
    "leader": "Координатор индекса",
    "agents": [
      "a4",
      "a7"
    ],
    "native": [],
    "votes": [
      {
        "member": "a4",
        "state": "unknown",
        "evidence": "Сохранённый голос отсутствует; ошибка исполнения не считается голосом block.",
        "observedAt": "2026-10-20T10:31:00+02:00"
      },
      {
        "member": "a7",
        "state": "block",
        "evidence": "Не уточнён контракт nullable-поля, хотя индексирование завершено.",
        "observedAt": "2026-10-20T10:38:00+02:00"
      }
    ],
    "decision": "Решение не принято: требуется уточнить контракт nullable-поля.",
    "delivery": "Отчёт индекса принят. Проверка типов завершилась ошибкой."
  },
  {
    "id": "p4",
    "name": "Надёжность исполнений",
    "project": "run",
    "source": "agent-run-legacy",
    "state": "awaiting-observation",
    "leader": "Ведущий прежнего пула",
    "agents": [
      "a2",
      "a5"
    ],
    "native": [],
    "votes": [
      {
        "member": "a2",
        "state": "unknown",
        "evidence": "В прежнем источнике отдельный голос не наблюдался.",
        "observedAt": "2026-10-20T10:29:00+02:00"
      },
      {
        "member": "a5",
        "state": "unknown",
        "evidence": "Нет сохранённого свидетельства о голосе.",
        "observedAt": "2026-10-20T10:29:00+02:00"
      }
    ],
    "decision": "В прежнем источнике нет отдельного состояния принятого решения.",
    "delivery": "Статус доставки неизвестен. Последнее наблюдение в 10:29."
  }
];

/** Authored fixture metadata keys with separate numeric observations; no live service response is translated. */
export const tools: Tool[] = [
  {
    "id": "run",
    "name": "Agent Run",
    "version": "0.8.2",
    "quotaState": "known",
    "metrics": {
      "used": 24,
      "limit": 100,
      "hours": 5,
      "slots": 4,
      "capacity": 8
    },
    "timestamps": {
      "reset": "2026-10-20T14:00:00+02:00"
    },
    "purpose": "Task execution and history",
    "state": "Available in prototype",
    "quota": "Provider OpenAI: {used} of {limit} requests per {hours} hours; reset {reset} · observed {time}",
    "detail": "Concurrency is separate from quota: {slots} of {capacity} slots occupied. Execution states saved {time}. One execution has no fresh observation.",
    "observedAt": "2026-10-20T10:42:00+02:00"
  },
  {
    "id": "ide",
    "name": "Agent IDE",
    "version": "0.6.1",
    "quotaState": "known",
    "metrics": {
      "symbols": 146,
      "files": 23
    },
    "timestamps": {},
    "purpose": "Symbols, changes and diagnostics",
    "state": "Findings recorded",
    "quota": "Index: {symbols} symbols in {files} files; excluded-file coverage unknown",
    "detail": "Index check: passed. TypeScript check: nullable-contract error. Excluded-file coverage unknown.",
    "observedAt": "2026-10-20T10:42:00+02:00"
  },
  {
    "id": "pool",
    "name": "Agent Pool",
    "version": "0.4.0",
    "quotaState": "not-applicable",
    "metrics": {},
    "timestamps": {},
    "purpose": "Discussions and decisions",
    "state": "Available in prototype",
    "quota": "This service makes no model requests",
    "detail": "Delivery acceptance, decisions and pool closure are independent states.",
    "observedAt": "2026-10-20T10:42:00+02:00"
  },
  {
    "id": "bridge",
    "name": "Agent Bridge",
    "version": "0.3.4",
    "quotaState": "not-applicable",
    "metrics": {
      "delivered": 28,
      "pending": 1,
      "failed": 1,
      "unknown": 1
    },
    "timestamps": {
      "incident": "2026-10-20T10:28:00+02:00"
    },
    "purpose": "Messages between tools",
    "state": "Delivery delayed",
    "quota": "Message delivery service",
    "detail": "Delivered: {delivered} · pending: {pending} · failed: {failed} · outcome unknown: {unknown}. Incident {incident}: no delivery acknowledgement. Unknown does not mean failed; no resend is performed.",
    "observedAt": "2026-10-20T10:42:00+02:00"
  },
  {
    "id": "tasks",
    "name": "Agent Tasks",
    "version": "0.5.0",
    "quotaState": "stale",
    "metrics": {
      "plans": 4
    },
    "timestamps": {},
    "purpose": "Saved plans and outcome estimates",
    "state": "Information is stale",
    "quota": "{plans} saved plans · observed {date}; current coverage unknown",
    "detail": "Estimates retain their dates and approximate stage progress. No fresh quota observation; the available remainder is unknown.",
    "observedAt": "2026-10-19T18:10:00+02:00"
  },
  {
    "id": "worktree",
    "name": "Agent Worktree",
    "version": "0.2.0",
    "quotaState": "unknown",
    "metrics": {
      "worktrees": 8,
      "unknown": 2
    },
    "timestamps": {},
    "purpose": "Working copies and state observations",
    "state": "Incomplete coverage",
    "quota": "Local observations without model requests; complete coverage unconfirmed",
    "detail": "{worktrees} working copies in the prototype. Cleanliness or full coverage is unknown for {unknown} records. Real paths are not checked.",
    "observedAt": "2026-10-20T10:42:00+02:00"
  }
];

/** State label keys are shared by filters and badges, while state IDs remain stable. */
export const statusLabels: Record<AgentStatus, MessageKey> = { running: 'Running', succeeded: 'Completed', failed: 'Error', unknown: 'No information' };
/** Source messages remain original text in every interface locale. */
export const demoMessages = {
  userInstruction: 'Сохрани результат проверки и укажи ограничения наблюдения.',
  assistantIntro: 'Проверю сохранённый контекст проекта, затем сопоставлю результат с критериями задачи. Неизвестные сведения отмечу отдельно.',
  contextResult: 'Результат: сохранённый план и последнее наблюдение получены из демонстрационного набора.',
  poolLeader: 'Сохраняем исходные состояния участников. Решение и приёмка результата не завершают исполнение автоматически.',
  poolReviewer: 'Проверено по сохранённым наблюдениям. Неполные сведения нужно показывать явно.',
  reviewerName: 'Ревьюер',
} as const;
/** Exact message timestamps are fixture data, not locale-specific text. */
export const messageTimes = { user: '2026-10-20T10:18:00+02:00', assistant: '2026-10-20T10:19:00+02:00', context: '2026-10-20T10:20:00+02:00', reviewer: '2026-10-20T10:26:00+02:00' } as const;
