import { Help, type Command } from 'commander';

/**
 * dropAlias removes `cmd`'s first alias from a help term commander built, turning `display|play` back
 * into `display`.
 *
 * Commander adds the alias as `name|alias` in exactly these two terms and nowhere else, so replacing
 * that one token is enough; rebuilding the terms from scratch would copy commander internals that
 * are not exported (humanReadableArgName).
 *
 * @param {string} term - The term commander built
 * @param {Command} cmd - The command it describes
 * @returns {string} The term without the alias
 */
function dropAlias(term: string, cmd: Command): string {
  const alias = cmd.alias();
  return alias ? term.replace(`${cmd.name()}|${alias}`, cmd.name()) : term;
}

/**
 * hiddenAliasHelp is a commander help configuration that names a command by its name only, never
 * by its alias.
 *
 * An alias in ff-cli is a retired command name kept so existing scripts and agents keep working:
 * `play` became `display` (B&F weekly 2026-11-03; Canon reference/naming-brand.md §3.4). Commander
 * would print it in the command list and the usage line (`display|play`), and help is where people
 * and agents learn the CLI's words, so printing it would teach the retired verb again. The alias
 * still parses and `ff-cli help play` still works; only the printed help drops it.
 *
 * Apply it to the program (the command list uses subcommandTerm) and to every aliased command (its
 * own usage line uses commandUsage): `addCommand` does not copy help configuration to subcommands.
 */
export const hiddenAliasHelp = {
  subcommandTerm: (cmd: Command): string => dropAlias(new Help().subcommandTerm(cmd), cmd),
  commandUsage: (cmd: Command): string => dropAlias(new Help().commandUsage(cmd), cmd),
};
