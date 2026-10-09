// Drag-and-drop zone with a browse button (interactive/action-panel
// with-dropzone). The native file input is visually hidden and driven by the
// iX button, so there is exactly one tab stop.

import { useRef, useState, type DragEvent } from "react";
import { IxButton, IxIcon, IxTypography } from "@siemens/ix-react";
import { iconUpload } from "@siemens/ix-icons/icons";
import styles from "./Portability.module.css";

export function FileDrop({
  buttonLabel,
  hint,
  accept,
  multiple = false,
  busy = false,
  onFiles,
}: {
  buttonLabel: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  busy?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setActive(false);
    if (busy) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  }

  return (
    <div
      className={`${styles.dropzone} ${active ? styles.dropActive : ""}`}
      onDrop={onDrop}
      onDragOver={(event) => {
        event.preventDefault();
        if (!active) setActive(true);
      }}
      onDragLeave={() => setActive(false)}
    >
      {/* Decorative: the hint and the button say what the zone does. */}
      <IxIcon name={iconUpload} size="24" color="color-primary" aria-hidden="true" />
      <IxTypography format="body" className={styles.text}>
        {hint}
      </IxTypography>
      <IxButton variant="secondary" loading={busy} disabled={busy} onClick={() => inputRef.current?.click()}>
        {buttonLabel}
      </IxButton>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className={styles.srOnly}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </div>
  );
}

/** Bulleted list of messages (warnings / issues). */
export function MessageList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className={styles.messageList}>
      {items.map((m, i) => (
        <li key={`${i}:${m}`}>
          <IxTypography format="body-sm">{m}</IxTypography>
        </li>
      ))}
    </ul>
  );
}
