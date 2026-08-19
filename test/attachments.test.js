import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AttachmentStore, ATTACHMENT_LIMITS } from '../src/attachments.js';

const dataUrl = (mimeType, value) => `data:${mimeType};base64,${Buffer.from(value).toString('base64')}`;

test('salva, hidrata e remove anexos locais sem colocar binários no histórico', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-attachments-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new AttachmentStore(directory).init();
  const conversationId = crypto.randomUUID();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image')]);
  const attachments = await store.saveMany(conversationId, [
    { name: '../plano.md', mimeType: 'text/plain', dataUrl: dataUrl('text/plain', '# Plano\nUsar PostgreSQL.') },
    { name: 'tela.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${png.toString('base64')}` },
    { name: 'guia.pdf', mimeType: 'application/pdf', dataUrl: dataUrl('application/pdf', '%PDF-1.4\nconteudo') }
  ]);

  assert.equal(attachments.length, 3);
  assert.ok(attachments.every(attachment => !('dataUrl' in attachment)));
  assert.equal(attachments[0].name.includes('/'), false);

  const conversation = { id: conversationId, messages: [{ role: 'user', content: 'Analise.', attachments }] };
  const hydrated = await store.hydrateConversation(conversation);
  assert.match(hydrated.messages[0].attachments[0].text, /PostgreSQL/);
  assert.match(hydrated.messages[0].attachments[1].dataUrl, /^data:image\/png;base64,/);
  assert.match(hydrated.messages[0].attachments[2].dataUrl, /^data:application\/pdf;base64,/);

  await store.deleteConversation(conversationId);
  await assert.rejects(() => store.read(conversationId, attachments[0].id), /ENOENT/);
});

test('bloqueia formatos, assinaturas e quantidades inválidas', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'genesis-attachments-invalid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new AttachmentStore(directory).init();
  const conversationId = crypto.randomUUID();

  await assert.rejects(
    () => store.saveMany(conversationId, [{ name: 'programa.exe', mimeType: 'application/octet-stream', dataUrl: dataUrl('application/octet-stream', 'MZ') }]),
    error => error.code === 'attachment_type_not_supported'
  );
  await assert.rejects(
    () => store.saveMany(conversationId, [{ name: 'imagem.png', mimeType: 'image/png', dataUrl: dataUrl('image/png', 'not a png') }]),
    error => error.code === 'invalid_image'
  );
  await assert.rejects(
    () => store.saveMany(conversationId, Array.from({ length: ATTACHMENT_LIMITS.maxFiles + 1 }, (_, index) => ({
      name: `arquivo-${index}.txt`, mimeType: 'text/plain', dataUrl: dataUrl('text/plain', 'ok')
    }))),
    error => error.code === 'too_many_attachments'
  );
});
