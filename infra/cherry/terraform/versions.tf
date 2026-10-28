terraform {
  required_version = ">= 1.5"
  required_providers {
    cherryservers = {
      source  = "cherryservers/cherryservers"
      version = "~> 1.6"
    }
  }
}

# API key from https://portal.cherryservers.com/settings/api-keys, via `export CHERRY_API_KEY=...`
# (or var.cherry_api_key). Never commit it.
provider "cherryservers" {
  api_key = var.cherry_api_key
}
