use scripting additions

on run
	try
		set helperPath to POSIX path of (path to resource "start-and-open")
		with timeout of 180 seconds
			do shell script "/bin/bash " & quoted form of helperPath
		end timeout
	on error errorMessage number errorNumber
		display dialog ("No se pudo abrir Obsidian Atlas." & linefeed & linefeed & errorMessage) with title "Obsidian Atlas" buttons {"Aceptar"} default button "Aceptar" with icon stop
	end try
end run
