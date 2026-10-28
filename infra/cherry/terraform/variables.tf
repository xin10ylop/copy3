variable "cherry_api_key" {
  description = "Cherry Servers API key. Leave null to use the CHERRY_API_KEY environment variable."
  type        = string
  default     = null
  sensitive   = true
}

variable "project_id" {
  description = "Cherry Servers project id."
  type        = number
}

variable "plan" {
  description = "Plan slug. Default AMD Ryzen 7950X (16c/128 GB/2x1 TB NVMe, EUR 199 = USD 232.83/mo). Check stock first: infra/cherry/provision.sh --list-stock. Bigger NVMe: amd-epyc-9375F or amd-threadripper-pro-7975wx (2x1 TB + 2x4 TB)."
  type        = string
  default     = "amd-ryzen-7950x"
}

variable "region" {
  type    = string
  default = "US-Chicago"
}

variable "image" {
  type    = string
  default = "ubuntu_24_04_64bit"
}

variable "hostname" {
  type    = string
  default = "hood-chi-1"
}

variable "cycle" {
  description = "Billing cycle slug: hourly (default) or monthly (cheaper, charged up front from the account balance)."
  type        = string
  default     = "hourly"
}

variable "os_partition_size_gb" {
  description = "OS partition size; the rest of that NVMe joins the /data RAID0 built by cloud-init."
  type        = number
  default     = 100
}

variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/id_ed25519.pub"
}

variable "repo_url" {
  description = "Git URL of this repository (cloned to /opt/hoodsniper)."
  type        = string
}

variable "repo_ref" {
  type    = string
  default = "main"
}

variable "git_token" {
  description = "Optional fine-grained read-only token for a private repo (stored in user-data: revoke after provisioning)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "dotenv_path" {
  description = "Optional path to a complete .env (infra/env/chicago.env.example) embedded in user-data. Empty = the box creates .env from the template and you fill it in over SSH."
  type        = string
  default     = ""
}
