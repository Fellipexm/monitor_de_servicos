@echo off
echo ===============================
echo  Corrigindo repositorio Git
echo ===============================

echo.
echo 1 - Corrigindo URL do remote...
git remote set-url origin https://github.com/Fellipexm/monitor_de_servicos.git

echo.
echo 2 - Criando .gitignore...

(
echo # Banco de dados
echo *.db
echo.
echo # Whatsapp session
echo .wwebjs_auth/
echo.
echo # Node
echo node_modules/
echo.
echo # Logs
echo *.log
echo.
echo # Variaveis de ambiente
echo .env
) > .gitignore

echo.
echo 3 - Removendo arquivos grandes do Git (mantendo no PC)...
git rm --cached -r .wwebjs_auth 2>nul
git rm --cached monitor.db 2>nul

echo.
echo 4 - Adicionando alteracoes...
git add .

echo.
echo 5 - Fazendo commit...
git commit -m "Remove arquivos grandes e adiciona gitignore" 2>nul

echo.
echo 6 - Forcando push...
git push origin main --force

echo.
echo ===============================
echo  Processo finalizado!
echo ===============================
pause