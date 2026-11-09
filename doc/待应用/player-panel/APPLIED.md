# Player panel storage source status

The five reviewed source files in install-manifest.json have been applied to D:/project/gogames with hash checks and backups. The authoritative implementation is now in that repository, including model registration and fixed data-center operation dispatch.

This is source application, not a database migration or deployment. No resident service was restarted. Run the existing InitMysqlDb migration and deploy matching data-center/Node versions before enabling production player persistence. Do not treat overlay or scripted-SQL tests as proof that production tables exist.
