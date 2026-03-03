@echo off
echo ===============================
echo  RESET TOTAL DO REPOSITORIO
echo ===============================

echo.
echo 1 - Apagando pasta .git...
rmdir /s /q .git

echo.
echo 2 - Iniciando novo repositorio...
git init

echo.
echo 3 - Criando .gitignore...

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
echo 4 - Adicionando arquivos...
git add .

echo.
echo 5 - Criando commit limpo...
git commit -m "Initial clean commit"

echo.
echo 6 - Adicionando remote correto...
git remote add origin https://github.com/Fellipexm/monitor_de_servicos.git

echo.
echo 7 - Forcando envio limpo...
git branch -M main
git push -u origin main --force

echo.
echo ===============================
echo  REPOSITORIO LIMPO E ENVIADO
echo ===============================
pause