# 0005: Secure notes use one data key, wrapped three ways

Status: accepted (2026-10-13), F-057

## Context
Secure notes need words that are unreadable on disk, one touch to open on a Mac, a passphrase on Linux, and a way back if the keychain is lost.

## Decision
- Per note: AES-256-GCM, random 96-bit nonce, `notes.sealed`; the key id is bound in as associated data. Title, type and dates stay plain.
- One random data key per workspace encrypts all secure notes. It is stored only wrapped (`secure_keys`): by the Mac keychain key (read only after a Touch ID yes), by a scrypt key from the Linux passphrase (n=2^17, r=8, p=1, per-wrap salt, params stored), and by a one-time recovery key (160 bits, 8 groups of 4, HKDF-SHA256) shown once when the first secure note is made.
- A backup carries ciphertext and wrapped keys. Import adds a backup's keys beside local ones (each note names its `keyId`), so merge-only holds and the recovery key opens the imported notes.
- Unlocked keys live only in an in-process keyring (idle-timeout hook for F-058), never on disk.

## Consequences
- Lose the keychain/passphrase and the recovery key: the words are gone. The UI must say so when it shows the key.
- Marking a note secure runs a VACUUM and FTS optimize so old plain words leave the file.
- Pictures used by a secure note stay plain files in `media/` (not covered).
- Pictures stay plain. Old `.fabric-backup` copies and backups exported before a note was secured keep that note's words.
- Each secure note has its own seal id bound into its ciphertext, so a sealed blob moved to another note without its seal id fails to open (someone who can edit the file can still swap whole rows). After a recovery-key unlock the machine adds its own wrap (Touch ID, or a passphrase on Linux).
