{{- define "helmsman-web.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "helmsman-web.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "helmsman-web.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "helmsman-web.labels" -}}
app.kubernetes.io/name: {{ include "helmsman-web.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "helmsman-web.selectorLabels" -}}
app.kubernetes.io/name: {{ include "helmsman-web.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "helmsman-web.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "helmsman-web.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Name of the Secret holding the auth (HELMSMAN_PASSWORD / HELMSMAN_TOKEN). */}}
{{- define "helmsman-web.authSecretName" -}}
{{- if .Values.auth.existingSecret -}}{{ .Values.auth.existingSecret }}{{- else -}}{{ include "helmsman-web.fullname" . }}-auth{{- end -}}
{{- end -}}

{{/* The admin password: explicit value, else the persisted generated one
     (re-read from the existing Secret on upgrade), else a fresh random one. */}}
{{- define "helmsman-web.password" -}}
{{- if .Values.auth.password -}}
{{- .Values.auth.password -}}
{{- else -}}
{{- $sec := (lookup "v1" "Secret" .Release.Namespace (printf "%s-auth" (include "helmsman-web.fullname" .))) -}}
{{- if and $sec $sec.data (index $sec.data "HELMSMAN_PASSWORD") -}}
{{- index $sec.data "HELMSMAN_PASSWORD" | b64dec -}}
{{- else -}}
{{- randAlphaNum 24 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Name of the Secret holding the claude (CLAUDE_CODE_OAUTH_TOKEN) value. */}}
{{- define "helmsman-web.claudeSecretName" -}}
{{- if .Values.claude.existingSecret -}}{{ .Values.claude.existingSecret }}{{- else -}}{{ include "helmsman-web.fullname" . }}-claude{{- end -}}
{{- end -}}
