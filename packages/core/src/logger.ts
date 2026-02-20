import type { LogEntry, LogLevel } from "./types.js";

const levelRank: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  OK: 25,
  WARN: 30,
  ERROR: 40,
};

export interface LogSink {
  write(entry: LogEntry): void | Promise<void>;
}

export interface LoggerOptions {
  component: string;
  level: LogLevel;
  sink?: LogSink;
}

export class Logger {
  private readonly component: string;
  private readonly minLevel: LogLevel;
  private readonly sink: LogSink | undefined;

  public constructor(options: LoggerOptions) {
    this.component = options.component;
    this.minLevel = options.level;
    this.sink = options.sink;
  }

  public debug(code: string, message: string, data?: Record<string, unknown>): void {
    void this.log("DEBUG", code, message, data);
  }

  public info(code: string, message: string, data?: Record<string, unknown>): void {
    void this.log("INFO", code, message, data);
  }

  public ok(code: string, message: string, data?: Record<string, unknown>): void {
    void this.log("OK", code, message, data);
  }

  public warn(code: string, message: string, data?: Record<string, unknown>): void {
    void this.log("WARN", code, message, data);
  }

  public error(code: string, message: string, data?: Record<string, unknown>): void {
    void this.log("ERROR", code, message, data);
  }

  private async log(level: LogLevel, code: string, message: string, data?: Record<string, unknown>): Promise<void> {
    if (levelRank[level] < levelRank[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      code,
      message,
    };
    if (data) {
      entry.data = data;
    }

    const rendered = `[${entry.ts}] [${level}] [${this.component}] ${code} ${message}${
      data ? ` ${JSON.stringify(data)}` : ""
    }`;

    if (level === "ERROR") {
      // eslint-disable-next-line no-console
      console.error(rendered);
    } else {
      // eslint-disable-next-line no-console
      console.log(rendered);
    }

    if (this.sink) {
      await this.sink.write(entry);
    }
  }
}
