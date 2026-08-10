---
name: Profiles are keyed by user_id, never id
description: Any lookup that maps an auth user (requester_id, actor_user_id, created_by…) to a display name must join public.profiles on user_id, not id
type: constraint
---

`public.profiles.id` is a surrogate primary key. The `auth.users.id` value
stored in columns like `requester_id`, `actor_user_id`, `created_by`,
`posted_by` lives in `profiles.user_id`.

Joining `profiles` on `id` returns zero rows silently, so UIs fall back to
printing raw UUIDs and PDFs print blanks/underscores. Always:

```ts
.from("profiles").select("user_id, full_name, email").in("user_id", authUserIds)
```

and key the resulting map by `user_id`.
