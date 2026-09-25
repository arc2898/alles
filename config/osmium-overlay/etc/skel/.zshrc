# Osmium OS — Kali-style two-row zsh configuration
# Row 1: ┌──(user@host)-[current-dir]   Row 2: └─>

# --- history ---
HISTFILE=~/.zsh_history
HISTSIZE=50000
SAVEHIST=50000
setopt HIST_IGNORE_DUPS HIST_IGNORE_SPACE HIST_REDUCE_BLANKS
setopt SHARE_HISTORY APPEND_HISTORY INC_APPEND_HISTORY

# --- auto repair: suggest corrections for mistyped commands ---
setopt CORRECT

# --- advanced tab completion ---
autoload -Uz compinit && compinit
zmodload zsh/complist 2>/dev/null || true
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}' 'r:|[._-]=* r:|=*'
zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"
zstyle ':completion:*' use-cache yes
zstyle ':completion:*' cache-path ~/.cache/zsh/zcompcache
setopt COMPLETE_IN_WORD ALWAYS_TO_END AUTO_MENU MENU_COMPLETE

# --- plugins (system-wide) ---
[ -r /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh ] && source /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh
[ -r /usr/share/zsh/plugins/zsh-history-substring-search/zsh-history-substring-search.zsh ] && source /usr/share/zsh/plugins/zsh-history-substring-search/zsh-history-substring-search.zsh
[ -r /usr/share/zsh/plugins/fzf-tab/fzf-tab.zsh ] && source /usr/share/zsh/plugins/fzf-tab/fzf-tab.zsh
[ -r /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ] && source /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# --- history substring search keys (up/down + vi/emacs) ---
bindkey '^[[A' history-substring-search-up 2>/dev/null || true
bindkey '^[[B' history-substring-search-down 2>/dev/null || true
bindkey -M vicmd 'k' history-substring-search-up 2>/dev/null || true
bindkey -M vicmd 'j' history-substring-search-down 2>/dev/null || true

# --- fzf-tab looks ---
zstyle ':fzf-tab:*' fzf-command ftb-tmux-popup 2>/dev/null || true
zstyle ':fzf-tab:complete:cd:*' fzf-preview 'ls --color=always $realpath' 2>/dev/null || true

# --- directory jumper (zoxide): z <partial>, zi (interactive) ---
command -v zoxide >/dev/null && eval "$(zoxide init --cmd z zsh)"

# --- direnv (per-directory env) ---
command -v direnv >/dev/null && eval "$(direnv hook zsh)"

# --- handy paths ---
for p in "$HOME/go/bin" "$HOME/.local/bin"; do
  case ":$PATH:" in *":$p:"*) ;; *) [ -d "$p" ] && export PATH="$p:$PATH";; esac
done
unset p

# --- Kali-style two-row prompt: user@host pwd / > ---
setopt PROMPT_SUBST
OSMIUM_PROMPT_USER='%(!.%F{9}.%F{14})%n@%m%f'
PROMPT='%F{12}┌──(%f'"$OSMIUM_PROMPT_USER"'%F{12})-[%f%F{11}%~%f%F{12}]%f
%F{12}└─%(?..%F{9}[%?]%f)%F{10}>%f '
unset OSMIUM_PROMPT_USER
