import type { MimeIconProps } from "@queryeer/api/files/FilesRegistry";

/** A generic leaf mark for .mongo files (not the MongoDB trademark logo). */
export function MongoIcon({ className, style }: MimeIconProps): JSX.Element {
  return (
    <svg className={className} style={style} viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
      <path
        d="M8 1c1.9 2.2 4 4.3 4 7.2 0 2.4-1.6 4.2-3.5 4.7L8 15l-.5-2.1C5.6 12.4 4 10.6 4 8.2 4 5.3 6.1 3.2 8 1z"
        fill="#4caf50"
      />
      <path d="M8 3.2v10.6" stroke="#2e7d32" strokeWidth="0.9" strokeLinecap="round" />
    </svg>
  );
}
