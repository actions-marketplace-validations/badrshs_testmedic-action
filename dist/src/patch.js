import fs from 'node:fs';
const preview = (text) => (text.length > 80 ? `${text.slice(0, 80)}...` : text);
export function applyEdits(filePath, edits) {
    if (edits.length === 0)
        return { ok: false, reason: 'No edits provided' };
    const original = fs.readFileSync(filePath, 'utf8');
    let content = original;
    for (const edit of edits) {
        if (!edit.old_string || edit.old_string === edit.new_string) {
            return { ok: false, reason: 'Empty or no-op edit' };
        }
        const first = content.indexOf(edit.old_string);
        if (first === -1) {
            return { ok: false, reason: `old_string not found in file: "${preview(edit.old_string)}"` };
        }
        if (content.indexOf(edit.old_string, first + 1) !== -1) {
            return { ok: false, reason: `old_string is not unique in file: "${preview(edit.old_string)}"` };
        }
        content = content.slice(0, first) + edit.new_string + content.slice(first + edit.old_string.length);
    }
    fs.writeFileSync(filePath, content);
    return { ok: true, original };
}
export function revertFile(filePath, original) {
    fs.writeFileSync(filePath, original);
}
