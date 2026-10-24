/**
 * System instructions with `{{name}}` placeholders. Values are user data (titles,
 * language tags), so they are flattened and length-capped before insertion and can
 * never add lines that read like instructions.
 */
export class InstructionTemplate {
  constructor(readonly text: string) {}

  render(values: Readonly<Record<string, string>>): string {
    return this.text.replace(/\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g, (_, name: string) => InstructionTemplate.sanitize(values[name] ?? ''));
  }

  static sanitize(value: string, maxLength = 160): string {
    // Control characters (including line breaks) become spaces; quotes cannot close the surrounding quote.
    const flat = Array.from(value, (char) => (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(char) ? ' ' : char)).join('');
    return flat.replace(/\s+/g, ' ').replace(/["“”]/g, "'").trim().slice(0, maxLength);
  }
}
