# Instalação no Windows

## Instalação automática

1. Clone ou baixe o repositório.
2. Abra a pasta `SupremeMind`.
3. Execute `install.bat`.

O instalador:

- verifica se o Node.js 20+ está instalado;
- executa `npm install --ignore-scripts`;
- registra o comando global com `npm link`;
- copia a Skill para `%USERPROFILE%\.codex\skills\suprememind`.

## Instalação pelo terminal

No Git Bash, PowerShell ou terminal do VS Code:

```powershell
git clone https://github.com/eiisrael/SupremeMind.git
cd SupremeMind
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

## Primeiro uso

Entre na raiz do projeto que será analisado:

```powershell
suprememind init
suprememind index
suprememind context "analise a arquitetura e encontre o fluxo de login" --budget 6000
```

## Atualização

Na pasta do SupremeMind:

```powershell
git pull
npm install --ignore-scripts
npm link
```

Depois atualize o índice dentro do projeto analisado:

```powershell
suprememind update
```

## Solução de problemas

### `suprememind` não é reconhecido

Feche e abra novamente o terminal. Depois confira:

```powershell
npm prefix -g
npm link
```

### Node.js antigo

Confira:

```powershell
node --version
```

É necessário Node.js 20 ou superior.

### Recriar o índice

```powershell
Remove-Item -Recurse -Force .suprememind
suprememind index --force
```
