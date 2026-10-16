import { useRef, useState } from 'react';
import { ArrowUp, Download, File, FilePlus, Folder, FolderPlus, Link2, Pencil, RefreshCw, Trash2, Upload } from 'lucide-react';
import { formatBytes, get, post, upload } from '../../api';
import { Empty, ErrorBox, Field, FormModal, Loading, Modal, Module, PageHead, useAction, useLoad } from '../../components/ui';

interface Entry { name: string; type: 'dir' | 'file' | 'link'; size: number; mtime: string; mode: string }

const join = (a: string, b: string) => (a ? `${a}/${b}` : b);
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');

export default function Files() {
  const [cwd, setCwd] = useState(() => new URLSearchParams(location.search).get('path') ?? 'public_html');
  const list = useLoad(() => get<Entry[]>(`/api/files/list?path=${encodeURIComponent(cwd)}`), [cwd]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<null | { kind: 'mkdir' | 'newfile' | 'rename' | 'chmod'; target?: Entry }>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { run, busy } = useAction();

  const go = (p: string) => {
    setSelected(new Set());
    setCwd(p);
    history.replaceState(null, '', `/files?path=${encodeURIComponent(p)}`);
  };
  const doUpload = (files: FileList | File[]) =>
    run(async () => { await upload(cwd, files); await list.reload(); }, `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`);

  const crumbs = cwd ? cwd.split('/') : [];
  const toggle = (name: string) => {
    const s = new Set(selected);
    if (s.has(name)) s.delete(name);
    else s.add(name);
    setSelected(s);
  };
  const entries = list.data ?? [];

  return (
    <>
      <PageHead title="File manager" sub="Your home folder. Website files for your main domain live in public_html.">
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files?.length && void doUpload(e.target.files).then(() => (e.target.value = ''))} />
        <button className="primary" disabled={busy} onClick={() => fileInput.current?.click()}><Upload /> Upload</button>
      </PageHead>

      <Module
        flush
        title={
          <div className="crumbs" aria-label="Current folder">
            <button onClick={() => go('')}>~</button>
            {crumbs.map((c, i) => (
              <span key={i} style={{ display: 'contents' }}>
                <span>/</span>
                <button onClick={() => go(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
              </span>
            ))}
          </div>
        }
        actions={
          <div className="toolbar">
            <button className="small" disabled={!cwd} onClick={() => go(parentOf(cwd))}><ArrowUp /> Up</button>
            <button className="small" onClick={() => setPrompt({ kind: 'newfile' })}><FilePlus /> New file</button>
            <button className="small" onClick={() => setPrompt({ kind: 'mkdir' })}><FolderPlus /> New folder</button>
            <button className="small" onClick={() => void list.reload()} aria-label="Refresh"><RefreshCw /></button>
            <button
              className="small danger"
              disabled={!selected.size || busy}
              onClick={() =>
                confirm(`Delete ${selected.size} item${selected.size === 1 ? '' : 's'}? Folders are deleted with everything inside.`) &&
                run(async () => {
                  await post('/api/files/delete', { paths: [...selected].map((n) => join(cwd, n)) });
                  setSelected(new Set());
                  await list.reload();
                }, 'Deleted')
              }
            >
              <Trash2 /> Delete{selected.size ? ` (${selected.size})` : ''}
            </button>
          </div>
        }
      >
        <div
          className={`dropzone${drag ? ' active' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void doUpload(e.dataTransfer.files); }}
        >
          {list.loading && !list.data ? <Loading /> : list.error ? <div className="module-body"><ErrorBox error={list.error} /></div> : entries.length === 0 ? (
            <Empty title="This folder is empty">Drop files here or use Upload.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={selected.size === entries.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(entries.map((x) => x.name)) : new Set())}
                      />
                    </th>
                    <th>Name</th><th>Size</th><th>Modified</th><th>Permissions</th><th />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((f) => (
                    <tr key={f.name}>
                      <td><input type="checkbox" aria-label={`Select ${f.name}`} checked={selected.has(f.name)} onChange={() => toggle(f.name)} /></td>
                      <td>
                        <button
                          className={`file-name${f.type === 'dir' ? ' dir' : ''}`}
                          onClick={() => (f.type === 'dir' ? go(join(cwd, f.name)) : f.type === 'file' ? setEditing(join(cwd, f.name)) : undefined)}
                        >
                          {f.type === 'dir' ? <Folder /> : f.type === 'link' ? <Link2 /> : <File />}
                          {f.name}
                        </button>
                      </td>
                      <td className="muted">{f.type === 'dir' ? '—' : formatBytes(f.size)}</td>
                      <td className="muted">{new Date(f.mtime).toLocaleString()}</td>
                      <td><button className="small ghost mono" onClick={() => setPrompt({ kind: 'chmod', target: f })}>{f.mode}</button></td>
                      <td className="actions">
                        {f.type === 'file' && (
                          <a className="btn small" href={`/api/files/download?path=${encodeURIComponent(join(cwd, f.name))}`} aria-label={`Download ${f.name}`}><Download /></a>
                        )}
                        <button className="small" onClick={() => setPrompt({ kind: 'rename', target: f })} aria-label={`Rename ${f.name}`}><Pencil /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Module>

      {editing && <Editor path={editing} onClose={() => { setEditing(null); void list.reload(); }} />}
      {prompt && <PromptModal cwd={cwd} prompt={prompt} onClose={() => setPrompt(null)} onDone={list.reload} onCreatedFile={(p) => setEditing(p)} />}
    </>
  );
}

function PromptModal({
  cwd, prompt, onClose, onDone, onCreatedFile,
}: { cwd: string; prompt: { kind: 'mkdir' | 'newfile' | 'rename' | 'chmod'; target?: Entry }; onClose: () => void; onDone: () => void; onCreatedFile: (p: string) => void }) {
  const initial = prompt.kind === 'rename' ? prompt.target!.name : prompt.kind === 'chmod' ? prompt.target!.mode : '';
  const [value, setValue] = useState(initial);
  const titles = { mkdir: 'New folder', newfile: 'New file', rename: `Rename ${prompt.target?.name}`, chmod: `Permissions for ${prompt.target?.name}` };
  const labels = { mkdir: 'Create folder', newfile: 'Create file', rename: 'Rename', chmod: 'Set permissions' };

  return (
    <FormModal
      title={titles[prompt.kind]}
      submitLabel={labels[prompt.kind]}
      onClose={onClose}
      onSubmit={async () => {
        const name = value.trim();
        if (prompt.kind === 'mkdir') await post('/api/files/mkdir', { path: join(cwd, name) });
        if (prompt.kind === 'newfile') {
          await post('/api/files/write', { path: join(cwd, name), content: '' });
          onCreatedFile(join(cwd, name));
        }
        if (prompt.kind === 'rename') await post('/api/files/rename', { from: join(cwd, prompt.target!.name), to: join(cwd, name) });
        if (prompt.kind === 'chmod') await post('/api/files/chmod', { path: join(cwd, prompt.target!.name), mode: name });
        onDone();
      }}
    >
      <Field label={prompt.kind === 'chmod' ? 'Mode' : 'Name'} hint={prompt.kind === 'chmod' ? '644 for files and 755 for folders suit most sites.' : undefined}>
        <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus className={prompt.kind === 'chmod' ? 'mono' : undefined} />
      </Field>
    </FormModal>
  );
}

function Editor({ path, onClose }: { path: string; onClose: () => void }) {
  const file = useLoad(() => get<{ content: string }>(`/api/files/read?path=${encodeURIComponent(path)}`), [path]);
  const [content, setContent] = useState<string | null>(null);
  const { run, busy } = useAction();
  const text = content ?? file.data?.content ?? '';
  const dirty = content !== null && content !== file.data?.content;

  const save = () => run(async () => {
    await post('/api/files/write', { path, content: text });
    file.setData({ content: text });
    setContent(null);
  }, `Saved ${path.split('/').pop()}`);

  return (
    <Modal
      wide
      title={path}
      onClose={() => (!dirty || confirm('Discard unsaved changes?')) && onClose()}
      footer={
        <>
          <a className="btn" href={`/api/files/download?path=${encodeURIComponent(path)}`}>Download</a>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      {file.loading ? <Loading /> : file.error ? <ErrorBox error={file.error} /> : (
        <textarea
          value={text}
          spellCheck={false}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); }
            if (e.key === 'Tab') {
              e.preventDefault();
              const t = e.currentTarget;
              const { selectionStart: s, selectionEnd: en } = t;
              setContent(text.slice(0, s) + '  ' + text.slice(en));
              requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
            }
          }}
          style={{ minHeight: '60vh', width: '100%' }}
          aria-label={`Contents of ${path}`}
        />
      )}
    </Modal>
  );
}
