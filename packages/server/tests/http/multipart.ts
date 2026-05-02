/**
 * Hand-rolled multipart/form-data body builder for `app.inject(...)` calls
 * in tests. Avoids pulling in `form-data` just for test fixtures.
 */

interface FieldPart {
  name: string;
  value: string;
}
interface FilePart {
  name: string;
  filename: string;
  contentType: string;
  body: Buffer;
}
type Part = FieldPart | FilePart;

export function buildMultipart(parts: Part[]): { body: Buffer; contentType: string } {
  const boundary = '----vinaTest' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in p) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`,
        ),
      );
      chunks.push(Buffer.from(`Content-Type: ${p.contentType}\r\n\r\n`));
      chunks.push(p.body);
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
      chunks.push(Buffer.from(p.value));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
