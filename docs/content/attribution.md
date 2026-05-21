# Attribution

Free-tier responses carry an attribution line. Surfacing Hauska catalog
data in a product on the free tier means displaying that attribution.

## The attribution string

Every free-tier response includes, in `meta.attribution`:

```
Powered by Hauska Engine — hauska.dev
```

## The requirement

If your agent or product surfaces answers derived from the Hauska catalog
to end users, and you are on a free tier, display the attribution string
where those answers appear. A footer line, an "about this answer" panel,
or a citation block all satisfy it. The intent is simple: a person seeing
a code answer can tell it is grounded in the Hauska substrate.

Attribution is not required for purely internal use that no end user
sees.

## Tiers and attribution

- **Free tiers** (unauthenticated and registered key): attribution
  required.
- **Developer Pro and Team**: attribution required.
- **Embedder License**: attribution requirement removed. Embedders
  integrating the catalog into their own branded product negotiate this
  as part of the license.

## Why it exists

Every attributed answer is a pointer back to the verified substrate. It
is how the catalog earns trust at the point of use, and it is the network
surface that makes the substrate worth maintaining for everyone.
