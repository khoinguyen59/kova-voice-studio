package main

import (
	"embed"
	"fmt"
	"io/fs"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var frontendAssets embed.FS

func main() {
	frontendDist, err := fs.Sub(frontendAssets, "frontend/dist")
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "KOVA Voice Studio frontend assets are unavailable:", err)
		return
	}
	app := NewApp()
	if err := wails.Run(&options.App{
		Title:            "KOVA Voice Studio",
		Width:            1520,
		Height:           960,
		MinWidth:         1120,
		MinHeight:        720,
		DisableResize:    false,
		BackgroundColour: &options.RGBA{R: 245, G: 249, B: 255, A: 255},
		AssetServer:      &assetserver.Options{Assets: frontendDist},
		OnStartup:        app.Startup,
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: true,
			CSSDropProperty:    "--wails-drop-target",
			CSSDropValue:       "drop",
		},
		Bind: []interface{}{app},
	}); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "KOVA Voice Studio stopped:", err)
	}
	if app.debugLog != nil {
		app.debugLog.Close()
	}
}
