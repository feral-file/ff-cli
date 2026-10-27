import * as readline from 'readline';
import chalk from 'chalk';

/**
 * Wrapper around readline that yields a promise-returning ask() function
 * and a close() to dispose the interface. Used by interactive commands
 * (setup, find, device add, unpublish, feed selection) so they share one
 * prompt convention.
 */
export interface Prompt {
  ask: (question: string) => Promise<string>;
  close: () => void;
}

/**
 * NON_TTY_ANSWER_TIMEOUT_MS bounds how long a question waits for an answer on
 * a stdin that is not a terminal.
 *
 * Piped answers (`echo n | ff-cli find …`) arrive at once and still work. An
 * agent harness that leaves stdin open but never writes to it would otherwise
 * wait forever, which reads as a hang the agent cannot diagnose.
 */
export const NON_TTY_ANSWER_TIMEOUT_MS = 10_000;

/**
 * NonInteractiveError reports a question that got no answer because stdin is
 * not a terminal: input ended first, or nothing arrived in time.
 *
 * Before this error, end-of-input left readline's callback uncalled and the
 * process exited 0 having done nothing (`find <url>` printed "Build playlist?
 * [Y/n]" and quit). That looks like success to a caller that trusts exit
 * codes, so the question fails loudly instead, naming what would answer it.
 *
 * Callers match on `name` (isNonInteractiveError), not `instanceof`: tests
 * replace this module with a stub that does not export the class.
 */
export class NonInteractiveError extends Error {
  constructor(question: string, hint?: string) {
    const asked = question.trim();
    super(
      `"${asked}" needs an answer, and none came: stdin is not a terminal.${hint ? ` ${hint}` : ''}`
    );
    this.name = 'NonInteractiveError';
  }
}

/**
 * isNonInteractiveError reports whether an error came from a question that
 * got no answer on a non-terminal stdin.
 *
 * @param {unknown} error - Any caught value
 * @returns {boolean} True for a NonInteractiveError
 */
export function isNonInteractiveError(error: unknown): boolean {
  return error instanceof Error && error.name === 'NonInteractiveError';
}

/** Input stream a prompt reads from; a seam for tests. */
type PromptInput = NodeJS.ReadableStream & { isTTY?: boolean };

/**
 * createPrompt returns a prompt that asks on stdin and never waits silently.
 *
 * The readline interface opens on the first question, not at creation, so a
 * command that never asks never attaches to stdin. A question rejects when
 * input ends before an answer (on a terminal that is Ctrl-D; otherwise a
 * NonInteractiveError), and, when stdin is not a terminal, when no answer
 * arrives within NON_TTY_ANSWER_TIMEOUT_MS.
 *
 * @param {string} [nonInteractiveHint] - What answers the question without a
 *   terminal (usually a flag); appended to the NonInteractiveError message
 * @param {Object} [options] - Test seams
 * @param {PromptInput} [options.input] - Stream to read answers from (default stdin)
 * @param {number} [options.answerTimeoutMs] - Non-terminal wait bound
 * @returns {Prompt} ask/close pair
 */
export function createPrompt(
  nonInteractiveHint?: string,
  options: { input?: PromptInput; answerTimeoutMs?: number } = {}
): Prompt {
  const input: PromptInput = options.input ?? process.stdin;
  const timeoutMs = options.answerTimeoutMs ?? NON_TTY_ANSWER_TIMEOUT_MS;
  let rl: readline.Interface | null = null;

  const ask = async (question: string): Promise<string> => {
    rl ??= readline.createInterface({ input, output: process.stdout });
    const iface = rl;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (finish: () => void) => {
        clearTimeout(timer);
        iface.off('close', onClose);
        finish();
      };
      const noAnswer = () =>
        input.isTTY
          ? new Error('Input closed before an answer was given.')
          : new NonInteractiveError(question, nonInteractiveHint);
      const onClose = () => settle(() => reject(noAnswer()));
      iface.once('close', onClose);
      if (!input.isTTY) {
        timer = setTimeout(
          () =>
            settle(() => {
              reject(noAnswer());
              iface.close();
            }),
          timeoutMs
        );
      }
      iface.question(chalk.yellow(question), (answer: string) =>
        settle(() => resolve(answer.trim()))
      );
    });
  };

  return {
    ask,
    close: () => rl?.close(),
  };
}

export async function promptYesNo(
  ask: (question: string) => Promise<string>,
  question: string,
  defaultYes = true
): Promise<boolean> {
  const suffix = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} [${suffix}] `)).trim().toLowerCase();
  if (!answer) {
    return defaultYes;
  }
  return answer === 'y' || answer === 'yes';
}
